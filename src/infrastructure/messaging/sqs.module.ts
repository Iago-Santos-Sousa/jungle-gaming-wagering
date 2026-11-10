import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: AppConfig): SQSClient {
  const { sqs } = config;
  return new SQSClient({
    region: sqs.region,
    endpoint: sqs.endpoint,
    credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: sqs.secretAccessKey },
    // O SDK já faz retry com backoff para erros de rede e throttling
    maxAttempts: 3,
  });
}

// Resolve e memoriza as URLs das filas. A memoização é só otimização de leitura.
@Injectable()
export class SqsQueueResolver {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  getUrl(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) return cached;
    const pending = this.resolve(queueName);
    this.urls.set(queueName, pending);
    // Falha não fica em cache, para a próxima chamada tentar de novo
    pending.catch(() => this.urls.delete(queueName));
    return pending;
  }

  private async resolve(queueName: string): Promise<string> {
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!QueueUrl) throw new Error(`Queue ${queueName} not found`);
    return QueueUrl;
  }
}

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: createSqsClient },
    SqsQueueResolver,
    SqsClientLifecycle,
  ],
  exports: [SQS_CLIENT, SqsQueueResolver],
})
export class SqsModule {}
