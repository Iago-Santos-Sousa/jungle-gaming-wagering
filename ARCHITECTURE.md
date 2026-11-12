# Arquitetura

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas. O ponto de partida é a pergunta que guiou o desenho: o que impede o sistema de duplicar crédito, duplicar débito, perder evento confirmado ou deixar saldo negativo quando há mensagens duplicadas, fora de ordem e várias instâncias concorrentes?

A resposta curta: **o banco**. Toda garantia financeira tem uma constraint, um índice único ou uma trigger correspondente no PostgreSQL. O código de aplicação existe para tomar as decisões de negócio e respeitar essas garantias, não para substituí-las.

## 1. Camadas

```
interfaces/http        interfaces/workers
(controllers, DTOs)    (consumer SQS, outbox, pending reference)
          \                 /
           application (use cases + portas)
                  |
               domain (Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox, eventos)
                  ^
           infrastructure (MikroORM, SQS, pino, prom-client)  implementa as portas
```

- **domain** não depende de NestJS nem do ORM. Construtores privados, factories estáticas (`create`, `open`, `from`, `rehydrate`) e transições explícitas. `rehydrate` reconstrói estado persistido sem revalidar transições.
- **application** expõe os casos de uso e define portas como classes abstratas (`UnitOfWork`, `Clock`, `IdGenerator`, `EventPublisher`, `WageringMetrics`), que também servem de token de injeção do Nest.
- A entrada HTTP e o consumer SQS chamam **o mesmo** `SubmitWagerTransactionUseCase`. O worker de referências pendentes reaproveita o mesmo `WagerSettlementWriter`, então as regras de escrita existem em um só lugar.
- As regras de negócio puras ficam em `settleWagerTransaction` (domínio, sem I/O), testadas por unidade.

## 2. ORM, mapeamento do Money e estratégia transacional

**MikroORM 7**, conforme a preferência do desafio. O que pesou:

- `EntityManager.fork()` por operação: identity map isolado e descartado ao fim, sem crescimento de memória nem estado compartilhado entre requisições (`allowGlobalContext: false` garante que ninguém use o EM global por engano).
- `em.transactional()` com commit apenas se o callback resolver, e `LockMode.PESSIMISTIC_WRITE` para o lock de linha.
- `defineEntity` sem decorators: as entidades de persistência ficam na infraestrutura e o domínio continua puro. Repositórios mapeiam registro ↔ entidade de domínio (`mappers.ts`).

Escolha consciente: os repositórios usam `em.insert`, `em.nativeUpdate` e SQL explícito (`em.execute`) em vez de `persist/flush`. Num fluxo financeiro, a ordem dos statements e o `UPDATE ... WHERE version = ?` condicionado precisam ser explícitos e imediatos, e o erro de cada constraint precisa aparecer no ponto em que acontece. O Unit of Work do ORM continua delimitando a transação.

**Money**: `decimal.js` (construtor isolado com `Decimal.clone`, precisão 40) no domínio. A entrada aceita só strings decimais não negativas com exatamente 2 casas (`"25"` e `"25.5"` são rejeitados): `NaN`, `Infinity`, notação científica, sinal, zeros à esquerda, vírgula e string vazia são rejeitados. Não há arredondamento implícito: mais de 2 casas é erro, não arredondamento. A saída é sempre `toFixed(2)`. No banco, valor e moeda ficam em colunas separadas (`numeric(20,2)` + `char(3)`), e o `DecimalType` do MikroORM devolve string, nunca `number`. `Money.rehydrate` aceita valores assinados vindos de agregações SQL (reconciliação). O modelo é multi-moeda e o desafio roda em BRL.

**Transação**: READ COMMITTED + lock de linha explícito. A wallet é a unidade de concorrência, então o lock da linha da wallet basta para serializar o que precisa ser serializado. SERIALIZABLE causaria aborts em operações que não conflitam de verdade.

## 3. Concorrência

Estratégia em três camadas, cada uma cobrindo a falha da anterior:

1. **Lock pessimista por wallet** (`SELECT ... FOR UPDATE`): duas apostas na mesma wallet são serializadas; wallets diferentes rodam em paralelo. Não existe lock global.
2. **Update condicionado à versão** (`UPDATE wallets ... WHERE id = ? AND version = ?`, conferindo linhas afetadas): se algum caminho de código esquecer o lock, o lost update vira erro em vez de sobrescrita silenciosa.
3. **Schema**: `CHECK (balance_amount >= 0)`, `UNIQUE (wallet_id, wallet_version)` no ledger, trigger que exige `version + 1` quando o saldo muda e constraint trigger adiada que exige um lançamento com o mesmo `balance_after` para cada versão da wallet.

Por que pessimista e não otimista com retry: numa wallet quente, o otimista transforma contenção em retries e em latência imprevisível; o pessimista enfileira no banco, e o tempo de lock é curto (transação sem I/O de rede). O custo é throughput limitado por wallet, aceitável porque o paralelismo entre wallets é total.

Detalhes que evitam travamentos:

- `lock_timeout` (5s) e `statement_timeout` (15s) configurados na conexão do pool. Lock timeout, deadlock e falha de serialização viram `ConcurrencyConflictError`, que é retentado até 3 vezes com jitter curto e depois sai como **503** (HTTP) ou retry com backoff (SQS).
- **Ordem fixa de locks** em todos os fluxos: inbox (quando há), wallet e depois transação. Sem ciclos, sem deadlock entre submissão e worker.
- Duplicatas concorrentes da mesma idempotency key esperam no lock da wallet e enxergam a transação já commitada. Se a corrida for entre wallets diferentes com a mesma key, o índice único dispara e o use case relê para responder replay ou conflito.
- Pool limitado por instância (`DB_POOL_MAX`, timeout de aquisição de 10s). Publicação no SQS acontece fora de transação, então nenhuma conexão fica presa esperando rede.

Cenário obrigatório (saldo 100.00, duas apostas de 80.00 simultâneas) e a mesma aposta 50 vezes em paralelo estão em `test/concurrency/http-concurrency.test.ts`, junto com o teste de 3 processos independentes contra o mesmo banco.

## 4. Idempotência

- `Idempotency-Key` é obrigatório e é a fonte da verdade; o default recomendado é `{providerId}:{externalTransactionId}`.
- **payloadHash**: SHA-256 (hex) do JSON canônico, com chaves ordenadas recursivamente e campos ausentes omitidos, do subconjunto de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (com `amount` sempre em escala fixa de 2 casas) e `referenceExternalTransactionId`. Header e metadados de transporte não entram.
- Mesma key e mesmo hash: replay com o resultado original, incluindo o saldo observado no momento da decisão (guardado em `result_balance_*`). Mesma key com hash diferente: **409** `IDEMPOTENCY_KEY_CONFLICT`. Mesmo `(providerId, externalTransactionId)` com outra key também é conflito.
- No banco: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- Nenhuma idempotência depende de memória. O único cache em memória é o das URLs das filas.

## 5. Modelo de dados

| Tabela | Garantias no schema |
| --- | --- |
| `wallets` | `UNIQUE (player_id, currency)`; `CHECK balance >= 0`; `CHECK version >= 1`; trigger: identidade imutável, version incrementa exatamente quando o saldo muda, exclusão proibida; constraint trigger adiada: saldo diferente do inicial vazio exige lançamento com o mesmo `balance_after` na mesma versão |
| `wager_transactions` | `UNIQUE (idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; CHECKs de kind, status, moeda, valor, referência obrigatória para REFUND/ROLLBACK, `failure_code` presente se e somente se REJECTED/FAILED, PROCESSED com `processed_at` e saldo observado; índice único parcial: uma reversão PROCESSED por referência; trigger: estado terminal imutável, campos de identidade imutáveis, exclusão proibida |
| `wallet_ledger_entries` | Append-only (trigger bloqueia UPDATE, DELETE e TRUNCATE); `UNIQUE (transaction_id)` (no máximo um lançamento por transação); `UNIQUE (wallet_id, wallet_version)`; CHECK aritmético `balance_after = balance_before ± amount`; `amount > 0`; saldos não negativos; FK composta `(wallet_id, currency)` garante a moeda da wallet e `(transaction_id, wallet_id)` garante que a transação é da mesma wallet |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | Índice parcial em `next_attempt_at WHERE published_at IS NULL` |

Índices de consulta: `wager_transactions (wallet_id, created_at)`, índice parcial da fila de `PENDING_REFERENCE` por `next_attempt_at` e por `(provider_id, reference_external_transaction_id)`. A paginação do ledger usa o índice único `(wallet_id, wallet_version)`.

IDs são UUIDv7 (`Bun.randomUUIDv7()`), ordenáveis no tempo e amigáveis a B-tree. Datas são `timestamptz` e saem em ISO-8601 UTC (`...Z`), formato sem ambiguidade para provedores em qualquer fuso; o container do Postgres usa `America/Sao_Paulo` para inspeção local, e `date-fns` faz a aritmética de backoff.

A migration inicial é versionada, escrita em SQL explícito (constraints, índices parciais e triggers não são geráveis pelo ORM) e reversível (`down` remove tudo; o teste de schema roda `down` e `up`). As migrations rodam no boot com `pg_advisory_lock`, então várias instâncias subindo juntas não competem.

## 6. Regras de negócio

| Operação | Saldo | Ledger | Regra |
| --- | --- | --- | --- |
| `BET` | débito | 1 `DEBIT` | rejeita com `INSUFFICIENT_FUNDS` se faltar saldo |
| `WIN` | crédito | 1 `CREDIT` | referência opcional; se informada, deve ser BET da mesma rodada |
| `LOSS` | nenhum | nenhum | registra o resultado; referência opcional como no WIN; aceita valor zero |
| `REFUND` | crédito | 1 `CREDIT` | reverte uma BET PROCESSED, uma única vez, pelo mesmo valor |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | reverte BET, WIN ou REFUND PROCESSED, uma única vez, pelo mesmo valor |

Transições de status:

```
PENDING ──► PROCESSED | REJECTED | FAILED
   │
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              ▲      │
              └──────┘ (nova tentativa)
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais: transicionar a partir deles lança `InvalidTransactionStateError` (erro de programação) e a trigger do banco também recusa.

Interpretações adotadas:

- **Reversão única por referência**: uma transação pode ser revertida uma vez, por REFUND **ou** ROLLBACK. O enunciado fala em "mesmo tipo"; aplicar a regra só por tipo permitiria REFUND e ROLLBACK da mesma BET, creditando duas vezes. O ROLLBACK de um REFUND referencia o REFUND, não a BET, e continua permitido.
- A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`).
- Referência existente mas ainda `PENDING` ou `PENDING_REFERENCE` é tratada como ausente. Referência `REJECTED` ou `FAILED` gera `REFERENCE_NOT_PROCESSED`.
- `walletId` inexistente gera **422** `WALLET_NOT_FOUND` sem persistir a transação, porque não há wallet para a FK. Os demais rejeitados são persistidos e auditáveis.
- `OPENING` é interno (`provider_id = 'internal'`), criado na mesma transação SQL da wallet quando o saldo inicial é positivo, e nunca aceito pela API ou pela fila. A abertura não incrementa `version`: a wallet nasce com `version = 1` e o lançamento de abertura ocupa a posição 1 do ledger.
- `processed_at` registra o momento da decisão terminal, inclusive para REJECTED.

### Códigos de falha

| `failureCode` | Situação | O que o provedor faz |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Desiste ou envia outra aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN ou REFUND deixaria saldo negativo | Ação operacional; diferente de aposta sem saldo |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrige o payload |
| `WALLET_NOT_FOUND` | Wallet inexistente | Corrige o `walletId` |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da wallet | Corrige o payload |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro do limite de tentativas | Investiga a referência |
| `REFERENCE_MISMATCH` | Referência de outro player, wallet, rodada ou moeda | Corrige a referência |
| `REFERENCE_INVALID_KIND` | Tipo de referência não permitido | Corrige a referência |
| `REFERENCE_NOT_PROCESSED` | Referência rejeitada ou falha | Desiste |
| `REFERENCE_ALREADY_REVERSED` | Referência já revertida | Desiste |
| `AMOUNT_MISMATCH` | Valor da reversão diferente da referência | Corrige o valor |
| `BALANCE_LIMIT_EXCEEDED` | Crédito levaria o saldo além de `numeric(20,2)` (18 dígitos inteiros) | Desiste |
| `INTERNAL_ERROR` | Erro permanente de infraestrutura (`FAILED`) | Contata o operador |

### Códigos HTTP

Consistentes em todos os endpoints. O corpo de erro é sempre `{ code, message, details?, correlationId }`.

| Status | Situação |
| --- | --- |
| 400 `VALIDATION_ERROR` | Payload ou parâmetro inválido, `Idempotency-Key` ausente, cursor inválido |
| 404 `NOT_FOUND` | Recurso inexistente nas consultas |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` ou `WALLET_ALREADY_EXISTS` |
| 422 | Rejeição de negócio (corpo com `status: REJECTED` e `failureCode`) |
| 202 | Aceita com processamento pendente (`PENDING_REFERENCE`) |
| 503 `SERVICE_UNAVAILABLE` | Falha transitória (lock, corrida de inserção na mesma key, banco fora, timeout), com `Retry-After` |
| 500 `PERMANENT_FAILURE` | Falha permanente conhecida (SQLSTATE das classes 22 e 23, transição ilegal de estado): reenviar igual não resolve |
| 500 `INTERNAL_ERROR` | Falha inesperada |

## 7. Referências fora de ordem

Uma transação cuja referência não existe vira `PENDING_REFERENCE`, com `reference_attempts` e `next_attempt_at`. O `PendingReferenceWorker` **reserva** as vencidas com um único `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`, que empurra `next_attempt_at` para o fim de um lease (`PENDING_REFERENCE_LEASE_MS`, 30s). Instâncias concorrentes recebem conjuntos disjuntos, sem disputar o lock das mesmas wallets nem gastar o pool à toa. O valor reservado de `next_attempt_at` funciona como token: depois do lock (mesma ordem do fluxo normal, wallet e depois transação), a instância só processa se a linha ainda estiver `PENDING_REFERENCE` com o mesmo token. Se o lease venceu e outra instância reservou, ou se a linha foi antecipada, ela desiste e a linha fica para o próximo ciclo. Não há coluna nova: o lease reaproveita `next_attempt_at` e o índice parcial existente.

- **Backoff exponencial**: 1s, 2s, 4s, ... com teto de 5min (`PENDING_REFERENCE_*`).
- **Limite de 10 tentativas** (incluindo a da chegada), cerca de 8,5 minutos ao todo. Justificativa: provedores costumam entregar a transação referenciada em segundos; minutos cobrem filas atrasadas e reinícios, sem deixar saldo esperando indefinidamente. Esgotado o limite, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected`.
- **Antecipação**: quando uma transação é processada, as dependentes da mesma wallet que esperam por ela têm `next_attempt_at` antecipado para agora (um `UPDATE` indexado na mesma transação), então o ROLLBACK que chegou antes da BET é aplicado no ciclo seguinte do worker, sem esperar o backoff.
- Erro permanente durante o reprocessamento marca `FAILED` com `INTERNAL_ERROR`, auditável, em vez de tentar para sempre.

## 8. Consumer SQS

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` e `wagering-events.fifo` (eventos de saída, ver seção 9).

- Inbox persistente por `(consumerName, messageId)` gravado **na mesma transação** do efeito financeiro (`INSERT ... ON CONFLICT DO NOTHING`). Uma entrega concorrente da mesma mensagem espera o commit da outra no índice e vira duplicata.
- O inbox guarda o `payload_hash` da mensagem (SHA-256 do hash de negócio mais a `idempotencyKey`). Uma duplicata com hash diferente é tratada como **conflito**, não como reentrega: a mensagem recebe ack sem efeito, gera log `warn` e incrementa `duplicates_detected_total{source="inbox_conflict"}`.
- `ack` (`DeleteMessage`) só depois do commit. Se o processo morre entre o commit e o ack, a reentrega encontra o inbox e só faz o ack.
- Classificação de falhas:
  - **negócio** (REJECTED, `WALLET_NOT_FOUND`, conflito de idempotência): terminal, ack;
  - **permanente** (JSON inválido, contrato violado, `kind = OPENING`): DLQ imediata com atributo `reason=invalid_message`;
  - **permanente de processamento** (SQLSTATE das classes 22 e 23, como overflow numérico ou violação de constraint, e transição ilegal de estado): DLQ imediata com `reason=permanent_error`, sem gastar as tentativas de retry;
  - **transitória** (lock, banco, timeout) e falhas não classificadas: `ChangeMessageVisibility` com backoff exponencial (2s a 300s) e nova entrega.
- **Limite de tentativas**: ao atingir `SQS_MAX_RECEIVES` (5) entregas, a própria aplicação envia para a DLQ (`reason=retries_exhausted`) e faz ack. O `RedrivePolicy` da fila fica em `SQS_MAX_RECEIVES + 1` como rede de segurança. Assim o limite não depende do emulador. O envio para a DLQ usa o `MessageId` original como deduplicação, para um crash entre envio e ack não duplicar a mensagem na DLQ.
- **SIGTERM** (`enableShutdownHooks`, `init: true` e `stop_grace_period: 30s` no compose): o consumer aborta o long polling, conclui as mensagens em andamento até `SHUTDOWN_TIMEOUT_MS` e devolve a visibilidade (`VisibilityTimeout = 0`) das que foram recebidas e ainda não começaram. O ORM só fecha depois, porque os workers param em `beforeApplicationShutdown`.
- FIFO: grupos (`MessageGroupId = walletId`) em paralelo, mensagens do mesmo grupo em ordem. Ordenação e deduplicação do broker são otimização; a correção vem do banco.

## 9. Transactional outbox

Transação, saldo, ledger, inbox (quando a entrada é SQS) e eventos são gravados na mesma transação SQL. Nada é publicado antes do commit.

O `OutboxPublisherWorker` roda em todas as instâncias:

1. **Claim com lease**: `UPDATE ... SET locked_until = now + lease WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *`. Publishers concorrentes recebem lotes disjuntos, e o statement termina na hora, sem transação aberta durante a publicação.
2. **Publicação** com `SendMessageBatch` na fila FIFO de eventos: `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`.
3. **Confirmação** do lote com um único `UPDATE ... WHERE id = ANY(...)`. Falhas parciais recebem `scheduleRetry` com backoff (1s a 60s) e `last_error`, sem limite de tentativas: evento confirmado nunca é descartado.

Se o processo morre depois do commit e antes de publicar, ou depois do claim, o lease vence e outra instância publica. A entrega é **at-least-once**: uma publicação duplicada carrega o mesmo `eventId` (id da linha da outbox), e o consumidor deduplica por ele. A deduplicação FIFO do SQS ainda suprime cópias dentro da janela de 5 minutos.

Agendamento e lease usam o `Clock` da aplicação, inclusive no SQL. Comparar `now()` do banco com horários gravados pela aplicação quebrava com relógios dessincronizados (o teste pegou um desvio de 6s entre host e container). Hoje, toda comparação usa a mesma fonte de tempo.

Eventos (classe abstrata `IntegrationEvent<T>` com `eventType` e `version` no tipo de cada subclasse; `data` sempre com `MoneyProps`):

| Evento | Quando | aggregateId |
| --- | --- | --- |
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive LOSS e OPENING | transação |
| `WagerTransactionRejected` | Rejeição de negócio | transação |
| `WalletBalanceChanged` | Somente quando o saldo muda | wallet |
| `WagerTransactionPendingReference` | Primeira vez que a referência está ausente | transação |

## 10. Reconciliação

`POST /wallets/:walletId/reconciliation` lê o saldo materializado e a soma assinada do ledger **num único statement** (mesmo snapshot). Divergência gera log `warn`, incrementa `reconciliation_divergences_total` e responde `consistent: false` com a diferença. Nada é corrigido automaticamente. O teste provoca uma divergência desligando as triggers e confirma que ela é sinalizada e mantida.

## 11. Observabilidade

- **Logs** JSON (`nestjs-pino`) com `correlationId` (header `X-Correlation-Id` ou gerado, devolvido na resposta), `messageId`, `transactionId`, `walletId` e `providerId` nas decisões, no consumer e nos workers. Corpo de requisição, payload financeiro completo e headers sensíveis não são logados.
- **Métricas** em `/metrics`: `wager_transactions_total{kind,status}`, `duplicates_detected_total{source}`, `retries_total{component}`, `dlq_messages_total{reason}`, `dlq_depth`, `lock_conflicts_total`, `outbox_lag_seconds`, `processing_duration_seconds{source}`, `reconciliation_divergences_total` e as métricas padrão do processo.
- **Health**: `/health/live` sem dependências e `/health/ready` com `select 1` e `GetQueueAttributes` (chamada real ao SQS a cada verificação, mesmo com a URL da fila em cache), ambos com timeout de 2s e sem autenticação.

## 12. Autenticação (não implementada)

Decisão: não implementar. Autenticação não pontua no desafio e competiria com correção financeira, concorrência e idempotência.

Ponto de extensão no código: um `AuthGuard` global (`src/interfaces/http/auth/auth.guard.ts`), hoje no-op, e o decorator `@Public()` já aplicado em health e métricas.

Desenho que seria adotado:

- **Keycloak** no compose, com um realm de provedores e um client por provedor no fluxo `client_credentials`.
- O guard valida o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`) e extrai o `provider_id` de um claim.
- Regra de domínio: o `providerId` do payload precisa ser igual ao do token, senão **403**. Isso fecha o caminho de um provedor submeter transações em nome de outro.
- Mensagens SQS seguem como canal interno confiável, mas o `providerId` delas continua sujeito às mesmas validações de domínio (referência do mesmo provider, idempotência por provider).

## 13. Testes

Unidade para o domínio puro e integração com PostgreSQL e MiniStack reais para todo o resto. Os testes de concorrência usam paralelismo real (requisições simultâneas e processos independentes), não mocks sequenciais. Toda suíte que mexe em saldo termina verificando `wallet.balance == soma do ledger == último balance_after`.

| Cenário obrigatório | Onde |
| --- | --- |
| Mesma aposta 50× em paralelo | `test/concurrency/http-concurrency.test.ts` |
| Disputa pelo saldo da mesma wallet (100.00 com 2×80.00) | `test/concurrency/http-concurrency.test.ts` |
| Wallets distintas em paralelo | `test/concurrency/http-concurrency.test.ts` |
| 3 processos simultâneos | `test/concurrency/http-concurrency.test.ts` (`Bun.spawn` com barreira de início) |
| Worker morto depois do commit e antes do ack | `test/integration/messaging.test.ts` |
| Dois publishers sobre a mesma outbox | `test/integration/messaging.test.ts` |
| ROLLBACK/REFUND antes da referência | `test/integration/messaging.test.ts` e `http-api.test.ts` |
| Reinício do serviço com consistência final | `test/integration/messaging.test.ts` |
| Migrations e constraints | `test/integration/schema.test.ts` |
| Retry e DLQ | `test/integration/messaging.test.ts` |

O "crash depois do commit" é simulado de forma determinística: o teste recebe a mensagem, executa o use case com o contexto de inbox (commit) e não faz ack. Matar um processo no instante exato entre commit e ack seria não determinístico. O reinício usa o shutdown real da aplicação (os mesmos hooks do SIGTERM) com outra instância assumindo a fila.

## 14. Trade-offs e limitações

- **Throughput por wallet** limitado pelo lock pessimista. Uma wallet muito quente serializa suas operações; o paralelismo entre wallets não é afetado.
- **Emulador**: o LocalStack passou a exigir conta e token em 2026, então o projeto usa o MiniStack, alternativa aceita pelo enunciado. O long polling dele tem granularidade de cerca de 5s; por isso os testes usam short polling. O limite de entregas e a DLQ ficam na aplicação para não depender da fidelidade do emulador.
- **Relógio**: leases e agendamentos dependem de relógios sincronizados entre as instâncias da aplicação (NTP em produção). O lease de 30s tolera desvios pequenos.
- **Métricas por instância**: cada processo expõe as suas; a agregação seria feita pelo Prometheus. `outbox_lag_seconds` e `dlq_depth` são globais porque vêm do banco e da fila.
- **Consumidor de eventos** fora do escopo: os eventos ficam em `wagering-events.fifo`, prontos para consumo com deduplicação por `eventId`.
- **Inbox e outbox crescem** sem limpeza. Em produção, um job removeria registros publicados ou processados mais antigos que a janela de redelivery.
- **Sem teste de carga** e **sem ledger de partidas dobradas**, ambos diferenciais opcionais.
- **Uma moeda em uso** (BRL), com o modelo multi-moeda e conflitos de moeda testados.
