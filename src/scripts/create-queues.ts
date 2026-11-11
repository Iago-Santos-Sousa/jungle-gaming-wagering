import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig, type AppConfig } from '../infrastructure/config/app-config';
import { createSqsClient } from '../infrastructure/messaging/sqs.module';

const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1_000;

const fifoAttributes = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

async function createQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
  return QueueUrl;
}

// Cria as filas de forma idempotente: CreateQueue com os mesmos atributos não falha se a fila existe
export async function createQueues(config: AppConfig, client: SQSClient): Promise<void> {
  const { sqs } = config;
  const visibility = String(sqs.visibilityTimeoutSeconds);
  const dlqUrl = await createQueue(client, sqs.wagerDlqName, { ...fifoAttributes, MessageRetentionPeriod: '1209600' });
  const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ ARN not available');

  // A aplicação move para a DLQ ao atingir SQS_MAX_RECEIVES. O redrive do broker é rede de segurança.
  const redrivePolicy = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: sqs.maxReceives + 1 });
  await createQueue(client, sqs.wagerQueueName, { ...fifoAttributes, VisibilityTimeout: visibility, RedrivePolicy: redrivePolicy });
  await createQueue(client, sqs.eventsQueueName, { ...fifoAttributes, VisibilityTimeout: visibility });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createSqsClient(config);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await createQueues(config, client);
        console.log(JSON.stringify({ level: 'info', msg: 'sqs queues ready', queues: [config.sqs.wagerQueueName, config.sqs.wagerDlqName, config.sqs.eventsQueueName] }));
        return;
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    client.destroy();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'failed to create sqs queues', error: String(error) }));
    process.exit(1);
  });
}
