import { parseArgs } from "node:util";
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../infrastructure/config/app-config";
import { createSqsClient } from "../infrastructure/messaging/sqs.module";

// Publica uma mensagem WagerTransactionRequested na fila de entrada, para testes manuais.
// Uso: bun src/scripts/send-wager-message.ts --wallet <id> --player <id> [--kind BET] [--amount 25.00]
//        [--external tx-1] [--reference tx-0] [--message-id msg-1] [--round round-1] [--provider provider-a] [--queue nome.fifo]
const { values } = parseArgs({
  options: {
    wallet: { type: "string" },
    player: { type: "string" },
    kind: { type: "string", default: "BET" },
    amount: { type: "string", default: "10.00" },
    currency: { type: "string", default: "BRL" },
    external: { type: "string" },
    reference: { type: "string" },
    "message-id": { type: "string" },
    round: { type: "string", default: "round-1" },
    game: { type: "string", default: "fortune-chimp" },
    provider: { type: "string", default: "provider-a" },
    queue: { type: "string" },
  },
});

if (!values.wallet || !values.player) {
  console.error("missing --wallet and --player");
  process.exit(1);
}

const config = loadConfig();
const client = createSqsClient(config);
const externalTransactionId = values.external ?? `tx-${Bun.randomUUIDv7()}`;
const messageId = values["message-id"] ?? `msg-${Bun.randomUUIDv7()}`;

const envelope = {
  messageId,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: values.provider,
    externalTransactionId,
    idempotencyKey: `${values.provider}:${externalTransactionId}`,
    playerId: values.player,
    walletId: values.wallet,
    roundId: values.round,
    gameId: values.game,
    kind: values.kind,
    money: { amount: values.amount, currency: values.currency },
    ...(values.reference
      ? { referenceExternalTransactionId: values.reference }
      : {}),
  },
};

try {
  const queueName = values.queue ?? config.sqs.wagerQueueName;
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );

  await client.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: values.wallet,
      // Deduplicação do broker pelo messageId do envelope: reenviar com o mesmo --message-id simula duplicata
      MessageDeduplicationId: `${messageId}-${Date.now()}`,
    }),
  );

  console.log(
    JSON.stringify({
      sent: true,
      queue: queueName,
      messageId,
      externalTransactionId,
    }),
  );
} finally {
  client.destroy();
}
