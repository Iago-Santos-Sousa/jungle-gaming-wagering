# Teste de carga

O teste mede capacidade e correção sob concorrência. Não existe meta de RPS. Os números valem para comparar cenários nesta máquina, e não para estimar produção. As limitações estão no fim do documento.

```bash
docker compose up -d --build   # API na 3000 e 2 réplicas de worker na 3001 e 3002
bun install
bun run test:load
```

Parâmetros por variável de ambiente:

| Variável               | Default                                                                | Uso                                        |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `LOAD_TARGETS`         | `http://localhost:3000,http://localhost:3001,http://localhost:3002`    | Instâncias que recebem as requisições      |
| `LOAD_CONCURRENCY`     | `32`                                                                   | Usuários virtuais                          |
| `LOAD_DURATION_S`      | `30`                                                                   | Duração medida de cada cenário             |
| `LOAD_WARMUP_S`        | `5`                                                                    | Aquecimento descartado antes da medição    |
| `LOAD_WALLETS`         | `200`                                                                  | Wallets do cenário distribuído             |
| `LOAD_DRAIN_TIMEOUT_S` | `60`                                                                   | Espera pela outbox drenar depois do cenário |
| `LOAD_SCENARIOS`       | `distributed,contention-replay,hot-wallet`                             | Cenários e ordem                           |

O relatório completo de cada execução fica em `test/load/results/<horário>.json`, uma pasta fora do Git. O processo termina com código 1 se alguma wallet ficar divergente do ledger ou se a mesma operação for aplicada duas vezes.

## Ambiente

| Item               | Valor                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Host               | Windows 11 Pro 10.0.22631, Intel Core i5-10400F (6 núcleos, 12 threads), 15,9 GB de RAM  |
| Docker             | Docker Desktop 29.8.0 com WSL2, VM com 12 CPUs e 5,8 GB                                  |
| Stack              | `docker compose`: 3 instâncias da aplicação (API e 2 workers), PostgreSQL 18 e MiniStack |
| Aplicação          | Bun 1.4.4, `DB_POOL_MAX=10` por instância (30 conexões), `DB_LOCK_TIMEOUT_MS=5000`       |
| Outbox             | `OUTBOX_BATCH_SIZE=50`, `OUTBOX_POLL_INTERVAL_MS=500`, um publisher por instância        |
| Gerador de carga   | `bun run test:load` no próprio host, fora do Docker                                       |

Cada execução final rodou num stack novo (`docker compose -p <projeto> up`), com banco e filas vazios, para um resultado não herdar o acúmulo do outro.

## Metodologia

- **Modelo fechado**: N usuários virtuais. Cada um envia uma requisição, espera a resposta e envia a próxima, sem pausa. O modelo mede capacidade sob concorrência fixa. Não mede a latência com taxa de chegada constante: quando o servidor fica lento, os usuários enviam menos, e a latência real numa fila aberta seria maior.
- **Distribuição**: round-robin entre as 3 instâncias. Todas disputam o mesmo banco, então os locks são entre processos de verdade.
- **Medição**: latência de ponta a ponta no cliente com `performance.now()`. Os percentis usam nearest rank sobre todas as amostras. Os 5s de aquecimento são descartados.
- **Classificação das respostas**: 201, 200 (replay) e 202 contam como sucesso. 422 é rejeição de negócio esperada. 503 é falha transitória, contada à parte. Qualquer outro status ou falha de rede é erro.
- **Conflitos de concorrência**: diferença de `lock_conflicts_total` e `retries_total` somada nas 3 instâncias, além dos 503, das rejeições `INSUFFICIENT_FUNDS` causadas pela disputa e dos replays.
- **Outbox lag**: `outbox_lag_seconds` amostrado a cada segundo durante o cenário. Depois do cenário, o script espera o lag voltar a zero até `LOAD_DRAIN_TIMEOUT_S`.
- **Correção**: `POST /wallets/:id/reconciliation` em todas as wallets do cenário. No cenário de replay, cada par de envios paralelos com a mesma key precisa ter no máximo uma resposta que não seja replay.

### Cenários

| Cenário             | Desenho                                                                                                                                                   | O que mede                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `distributed`       | 200 wallets particionadas entre os usuários, sem disputa entre eles. BET 60%, WIN 25%, LOSS 10% e ROLLBACK 5% de uma BET do próprio usuário              | Vazão entre wallets diferentes             |
| `contention-replay` | 20 wallets com 30.00 compartilhadas por todos. BET e WIN de 10.00. Em 20% das operações, o mesmo corpo e a mesma key são enviados duas vezes em paralelo | Disputa de saldo, idempotência concorrente |
| `hot-wallet`        | Uma wallet para todos os usuários, com BET e WIN de 1.00 alternados                                                                                       | Serialização do lock pessimista            |

## Resultados

Duas execuções de 30s por cenário, com 32 e com 128 usuários virtuais. Latências em milissegundos.

| Cenário             | Usuários | Requisições |   RPS |  p50 |   p95 |   p99 |   máx | Erros | 503 | Lock conflicts | Retries |
| ------------------- | -------: | ----------: | ----: | ---: | ----: | ----: | ----: | ----: | --: | -------------: | ------: |
| `distributed`       |       32 |      12.386 | 412,9 |   49 |   180 |   214 | 1.241 |     0 |   0 |              0 |       0 |
| `contention-replay` |       32 |      15.066 | 502,2 |   63 |   162 |   247 |   454 |     0 |   0 |              0 |       0 |
| `hot-wallet`        |       32 |       3.249 | 108,3 |  297 |   451 |   521 |   682 |     0 |   0 |              0 |       0 |
| `distributed`       |      128 |      11.866 | 395,5 |  186 |   915 | 1.094 | 1.286 |     0 |   0 |              0 |       0 |
| `contention-replay` |      128 |      14.632 | 487,7 |  298 |   430 |   525 |   954 |     0 |   0 |              1 |       1 |
| `hot-wallet`        |      128 |       2.961 |  98,7 | 1.303 | 2.066 | 2.640 | 5.847 |     0 |   0 |              0 |       0 |

Taxa de erro de 0% em todas as linhas. A coluna de lock conflicts soma `lock_conflicts_total`. O conflito com 128 usuários foi absorvido pela nova tentativa interna (`retries_total{component="submit"}`) e não chegou ao cliente como 503.

Disputa e idempotência no `contention-replay`:

| Usuários | 201    | 200 (replay) | 422 `INSUFFICIENT_FUNDS` | Replays no corpo | Pares aplicados duas vezes |
| -------: | -----: | -----------: | -----------------------: | ---------------: | -------------------------: |
|       32 | 12.325 |        2.440 |                      301 |            2.481 |                          0 |
|      128 | 11.985 |        2.378 |                      269 |            2.428 |                          0 |

"Replays no corpo" inclui os 422 repetidos, que voltam com `idempotentReplay: true`. Em `duplicates_detected_total{source="http"}`, o valor é maior que o contado pelo cliente (2.865 contra 2.481 com 32 usuários) porque o contador do servidor inclui as requisições do aquecimento e as que estavam em voo nas bordas da janela de medição.

Outbox lag em segundos (lag é a idade do evento pendente mais antigo):

| Cenário             | Usuários | No início | Máximo | No fim | Drenou em 60s |
| ------------------- | -------: | --------: | -----: | -----: | ------------- |
| `distributed`       |       32 |         0 |   29,3 |   30,2 | não           |
| `contention-replay` |       32 |      74,2 |  111,8 |  116,5 | não           |
| `hot-wallet`        |       32 |     115,2 |  142,6 |  149,7 | não           |
| `distributed`       |      128 |         0 |   30,1 |   28,8 | não           |
| `contention-replay` |      128 |      74,7 |  111,6 |  115,7 | não           |
| `hot-wallet`        |      128 |     102,6 |  150,5 |  147,0 | não           |

Reconciliação: 221 wallets por execução, nenhuma divergente.

## Análise

**Correção.** Nas duas execuções e nas medições exploratórias anteriores, nenhuma wallet divergiu do ledger, nenhum par paralelo com a mesma key foi aplicado duas vezes e nenhum saldo ficou negativo. O banco recusaria esse caso pela `CHECK`. As rejeições `INSUFFICIENT_FUNDS` vieram da disputa real de saldo, e os replays devolveram o resultado original.

**Vazão entre wallets.** A vazão ficou entre 400 e 500 req/s nos cenários sem wallet quente e praticamente não mudou de 32 para 128 usuários. A latência subiu na mesma proporção (p50 de 49 para 186 ms). Esse é o sinal de saturação: com 128 usuários, as requisições esperam na fila do pool (10 conexões por instância) e da CPU, sem ganho de vazão. O gargalo é a máquina inteira, porque gerador, 3 instâncias, PostgreSQL e emulador dividem os mesmos 6 núcleos físicos. O `contention-replay` teve vazão maior que o `distributed` porque cerca de 18% das respostas são replays, que não gravam nada, ou rejeições, que não gravam ledger nem evento de saldo.

**Wallet quente.** Uma wallet sozinha ficou em cerca de 100 req/s, independentemente da concorrência, porque o `SELECT ... FOR UPDATE` serializa as operações dela. Com 128 usuários, a latência passou a refletir só a fila no lock: p99 de 2,6s e máximo de 5,8s. O máximo inclui a fila do pool e o HTTP, mas a espera no lock ficou abaixo do `lock_timeout` de 5s, e por isso não houve 503. Com mais usuários ou transações mais longas na mesma wallet, a espera passaria de 5s e as requisições começariam a voltar como 503 com `Retry-After`. Esse é o comportamento projetado: o lock pessimista troca vazão por wallet por previsibilidade, e o paralelismo entre wallets não é afetado (ARCHITECTURE.md §3).

**Conflitos de lock.** Houve um único conflito em todas as execuções, absorvido pela nova tentativa interna. Como a ordem de locks é fixa e a transação não faz I/O de rede, deadlock e timeout ficaram raros mesmo com contenção alta. A contenção apareceu como latência, e não como erro.

**Outbox lag, o resultado negativo.** A outbox não acompanhou a carga em nenhum cenário. Cada transação aplicada gera de 1 a 2 eventos (`WagerTransactionProcessed` e, quando o saldo muda, `WalletBalanceChanged`), então 400 a 500 req/s produzem de 700 a 900 eventos/s. Sem tráfego HTTP, a drenagem medida no banco (eventos com `published_at` gravado em 30s) foi de 205 eventos/s no stack isolado, com cerca de 70 mil mensagens na fila de eventos do emulador. Numa execução exploratória anterior, com 166 mil mensagens acumuladas na mesma fila, caiu para 90 eventos/s. Na execução de 32 usuários, 42.821 dos 70.336 eventos gerados saíram durante os cerca de 5 minutos do teste, uma média de cerca de 140 eventos/s. O lag cresceu quase na mesma velocidade do relógio (cerca de 30s de lag em 30s de carga) e só caiu depois que a carga parou. Ao fim de cada execução havia de 24 mil a 27 mil eventos pendentes, todos publicados depois. Nenhum evento foi perdido: o lag atrasa a notificação, não o efeito financeiro, que já está confirmado no banco.

Causas, da mais para a menos relevante:

1. **Emulador degradado.** Um `SendMessageBatch` isolado leva 4 ms com o MiniStack ocioso. Com 114 mil mensagens na fila de eventos (sem consumidor) e os 3 publishers chamando ao mesmo tempo, a mesma chamada levou de 0,9s a 1,3s. Durante a carga, o emulador ainda divide CPU com a API, o banco e o gerador.
2. **Um evento por agregado por chamada.** Para preservar a ordem diante de falhas parciais, um lote nunca leva dois eventos do mesmo agregado. A wallet quente gera cerca de 100 eventos de saldo por segundo, mas publica no máximo um por rodada. Quando há muitas cabeças de outros agregados, ela recebe um evento por ciclo. Esse acúmulo é o mais lento de drenar.
3. **Ciclo sequencial por instância.** Cada publisher faz claim, publicação e confirmação de até 50 eventos por ciclo, um ciclo por vez.

Correção derivada da análise: com um ciclo de muitas rodadas e o broker lento (50 rodadas de cerca de 1,3s numa wallet com acúmulo), o ciclo passaria do lease de 30s. Outro publisher assumiria então a cabeça ainda não confirmada enquanto o primeiro enviava os eventos seguintes, e a ordem por agregado quebraria. O publisher agora não abre rodada depois da metade do lease. O que não saiu volta sem tentativa nem backoff e segue no próximo ciclo (`PublishOutboxUseCase`, com teste em `test/unit/publish-outbox.test.ts`).

Caminhos para reduzir o lag, não implementados para não ampliar o escopo:

- enviar vários eventos do mesmo agregado num lote, em ordem, e tratar a falha parcial cortando o agregado na primeira entrada recusada, o que exige confirmar que as entradas seguintes do mesmo grupo não são aceitas;
- mais publishers por instância, ou instâncias dedicadas à outbox;
- `OUTBOX_BATCH_SIZE` maior, que dilui o custo do claim e da confirmação;
- medir contra SQS real, onde a latência do broker não divide CPU com a aplicação.

## Limitações do experimento

- O gerador e o sistema dividem a mesma máquina, e o Docker Desktop roda numa VM. Os números valem para comparação relativa entre cenários.
- O MiniStack não é o SQS. A latência dele sob carga e a falta de throttling não representam a AWS.
- Cada cenário durou 30s. O teste não mostra efeitos de longa duração, como crescimento das tabelas, vacuum ou vazamento de memória.
- O modelo é fechado, então os percentis subestimam a latência que um provedor com taxa de chegada fixa veria perto da saturação.
- Os cenários de uma execução rodam em sequência no mesmo stack. O lag no início do segundo e do terceiro cenário é herdado do anterior. Por isso a tabela traz o lag inicial, e a vazão HTTP de cada cenário não depende da outbox.
- O teste cobre a entrada HTTP. O consumer SQS usa o mesmo use case, mas a vazão dele não foi medida.
