# Jungle Gaming: Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS. O sistema permanece correto com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- Idempotência persistente (`Idempotency-Key` + inbox por `(consumerName, messageId)`)
- Ledger imutável com saldo materializado sempre igual ao saldo reconstruído
- Lock por wallet, nunca global, com invariantes garantidas no schema do banco
- Transactional outbox com publishers concorrentes
- Reprocessamento agendado de referências que chegam antes da transação referenciada

As decisões técnicas, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Item | Escolha |
| --- | --- |
| Runtime, package manager e test runner | Bun 1.4 |
| Linguagem | TypeScript em modo estrito |
| Framework | NestJS 11 |
| ORM | MikroORM 7 (`@mikro-orm/postgresql`) |
| Banco | PostgreSQL 18 |
| Mensageria | AWS SQS FIFO via MiniStack (`@aws-sdk/client-sqs`) |
| Dinheiro | `decimal.js` com escala fixa de 2 casas |
| Logs e métricas | `nestjs-pino` (JSON) e `prom-client` |
| Documentação da API | Swagger (`@nestjs/swagger`) |
| Orquestração local | Docker Compose |

## Pré-requisitos

- Docker com Docker Compose v2
- Bun 1.4 (opcional, só para rodar fora do Docker)

## Subindo o projeto

```bash
docker compose up -d --build
```

Não é preciso criar `.env`: o `docker-compose.yml` tem valores default para tudo. Para customizar, copie o exemplo e ajuste:

```bash
cp .env.example .env
```

Serviços:

| Serviço | Papel | Porta no host |
| --- | --- | --- |
| `wagering-postgres` | PostgreSQL | `5432` |
| `wagering-sqs` | MiniStack (SQS) | `4566` |
| `wagering-sqs-init` | Cria as filas FIFO e a DLQ de forma idempotente e encerra | |
| `wagering-api` | API HTTP + workers | `3000` |
| `wagering-worker` | 2 réplicas extras da mesma imagem (sem porta exposta) | |

São 3 instâncias da aplicação disputando as mesmas wallets, a mesma fila e a mesma outbox. As tabelas são criadas automaticamente: cada instância roda as migrations pendentes no boot, serializadas por advisory lock.

| Endereço | Conteúdo |
| --- | --- |
| http://localhost:3000/docs | Swagger com exemplos de payload e resposta |
| http://localhost:3000/docs-json | Documento OpenAPI |
| http://localhost:3000/health/live | Liveness |
| http://localhost:3000/health/ready | Readiness (PostgreSQL e SQS) |
| http://localhost:3000/metrics | Métricas Prometheus |

Para parar e remover os dados:

```bash
docker compose down -v
```

## Testes

Tudo roda contra PostgreSQL e MiniStack reais, sem mocks de banco ou fila. Com o stack no ar:

```bash
docker compose --profile test run --rm wagering-tests
```

Os testes usam um banco próprio (`wagering_test`, recriado a cada execução) e filas próprias, então não interferem nos dados da API.

| Suíte | Conteúdo |
| --- | --- |
| `test/unit` | `Money`, invariantes da `Wallet`, regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, conflito de moeda, hash de idempotência, outbox e backoff |
| `test/integration/schema.test.ts` | Migrations reversíveis e constraints do banco |
| `test/integration/http-api.test.ts` | Endpoints, códigos HTTP, replay, conflitos, reconciliação |
| `test/integration/messaging.test.ts` | Inbox e redelivery, crash antes do ack, retry e DLQ, referências fora de ordem, publishers concorrentes, reinício |
| `test/concurrency/http-concurrency.test.ts` | 50 apostas idênticas em paralelo, 2×80.00 sobre 100.00, wallets em paralelo, 3 processos independentes |

Fora do Docker (Postgres e MiniStack do compose precisam estar no ar):

```bash
bun install
docker compose up -d wagering-postgres wagering-sqs wagering-sqs-init
bun run test            # tudo
bun run test:unit       # só unidade
bun run typecheck
```

Teste de carga contra o stack do compose no ar (API e réplicas de worker com portas no host). Ambiente, metodologia, resultados e análise estão em [LOAD-TEST.md](LOAD-TEST.md):

```bash
bun run test:load
```

## Exemplos com curl

```bash
# Criar wallet (saldo inicial gera a transação interna OPENING e um CREDIT no ledger)
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# Submeter uma aposta (repita o mesmo comando para ver o replay: 200 com idempotentReplay=true)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# Consultas
curl -s localhost:3000/wallets/<walletId>
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=50"           # use nextCursor em ?cursor=
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Reconciliação entre saldo materializado e ledger
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation
```

Códigos HTTP do `POST /wagering/transactions`:

| Status | Significado | Pode reenviar? |
| --- | --- | --- |
| `201` | Aplicada | |
| `200` | Replay de requisição idêntica (`idempotentReplay: true`) | |
| `202` | Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | Sim, recebe o mesmo resultado |
| `400` | Payload inválido ou `Idempotency-Key` ausente | Só depois de corrigir |
| `409` | Mesma key (ou mesmo `externalTransactionId`) com payload diferente | Não |
| `422` | Rejeitada por regra de negócio (`failureCode`) | Não muda o resultado |
| `503` | Falha transitória (header `Retry-After`) | Sim, com a mesma key |
| `500` | `PERMANENT_FAILURE` (falha permanente conhecida) ou `INTERNAL_ERROR` (inesperada) | Não sem correção |

## Enviando mensagens pela fila

O script publica um `WagerTransactionRequested` em `wager-transactions.fifo`:

```bash
docker compose exec wagering-api bun src/scripts/send-wager-message.ts \
  --wallet <walletId> --player <playerId> --kind BET --amount 10.00 --external tx-sqs-1

# Mesmo --message-id reenviado simula redelivery: o efeito é aplicado uma única vez
docker compose exec wagering-api bun src/scripts/send-wager-message.ts \
  --wallet <walletId> --player <playerId> --kind WIN --amount 5.00 --external tx-sqs-2 --message-id msg-1
```

Opções: `--kind`, `--amount`, `--currency`, `--external`, `--reference`, `--message-id`, `--round`, `--provider`, `--queue`.

Os eventos de integração são publicados pela outbox em `wagering-events.fifo`. Mensagens com erro permanente ou com tentativas esgotadas vão para `wager-transactions-dlq.fifo`.

## Variáveis de ambiente

Todas têm default; a lista completa e comentada está em [.env.example](.env.example). As principais:

| Variável | Default | Uso |
| --- | --- | --- |
| `WORKERS_ENABLED` | `true` | Liga consumer SQS, publisher da outbox e worker de referências pendentes |
| `WORKER_REPLICAS` | `2` | Réplicas extras do serviço `wagering-worker` |
| `WORKER_HOST_PORTS` | `3001-3002` | Portas no host das réplicas (uma por réplica), usadas pelo teste de carga |
| `DB_POOL_MAX` | `10` | Conexões por instância (total no banco = pool × instâncias) |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock de uma wallet antes de virar erro transitório |
| `SQS_MAX_RECEIVES` | `5` | Entregas antes de a mensagem ir para a DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | Tentativas de resolver uma referência antes de `REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_LEASE_MS` | `30000` | Lease de um lote de referências pendentes reservado por uma instância |
| `OUTBOX_LEASE_MS` | `30000` | Lease de um lote reservado pelo publisher |

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos (sem Nest nem ORM)
  application/       casos de uso e portas (UnitOfWork, Clock, IdGenerator, EventPublisher, métricas)
  infrastructure/    MikroORM (entidades, migrations, repositórios), SQS, logs, métricas, config
  interfaces/http/   controllers, DTOs, filtro de erros, Swagger (exemplos em docs/)
  interfaces/workers/ consumer SQS, publisher da outbox, reprocessador de referências
  scripts/           criação de filas e envio de mensagens de teste
test/                unit, integration, concurrency, load e support
```
