// Exemplos de resposta dos health checks usados na documentação Swagger
export const HealthExamples = {
  live: { status: 'ok' },
  ready: { status: 'ok', checks: { database: 'up', sqs: 'up' } },
  notReady: { status: 'unavailable', checks: { database: 'up', sqs: 'down' } },
} as const;
