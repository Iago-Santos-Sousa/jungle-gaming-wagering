import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

// Documentação OpenAPI servida em /docs (JSON em /docs-json)
export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Jungle Gaming Wagering API')
      .setDescription(
        'Processador distribuído de apostas: wallets, ledger imutável, transações idempotentes (BET, WIN, LOSS, REFUND, ROLLBACK) e reconciliação. Valores monetários são strings decimais com 2 casas.',
      )
      .setVersion('1.0.0')
      .addTag('wallets')
      .addTag('wagering')
      .addTag('health')
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
}
