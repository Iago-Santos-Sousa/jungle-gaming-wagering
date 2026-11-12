import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { LedgerPageResponse, ReconciliationResponse, WalletResponse, CreateWalletDto } from '../dto/wallet.dto';
import { ErrorResponse, SubmitWagerTransactionDto, WagerTransactionResponse, WagerTransactionResultResponse } from '../dto/wager.dto';
import { CommonExamples, WagerExamples, WalletExamples } from './examples';


const errorResponse = (status: HttpStatus, description: string, example: object) =>
  ApiResponse({ status, description, type: ErrorResponse, content: { 'application/json': { example } } });

const notFound = () => errorResponse(HttpStatus.NOT_FOUND, 'Recurso inexistente', CommonExamples.notFound);
const invalidPayload = (example: object = CommonExamples.invalidId) => errorResponse(HttpStatus.BAD_REQUEST, 'Payload ou parâmetro inválido', example);
const unavailable = () =>
  errorResponse(HttpStatus.SERVICE_UNAVAILABLE, 'Falha transitória de infraestrutura (header Retry-After); pode reenviar', WagerExamples.unavailable);
const walletIdParam = () => ApiParam({ name: 'walletId', format: 'uuid' });

export const ApiCreateWallet = () =>
  applyDecorators(
    ApiOperation({ summary: 'Cria uma wallet', description: 'Saldo inicial maior que zero gera a transação interna OPENING e um CREDIT no ledger, na mesma transação SQL.' }),
    ApiBody({ type: CreateWalletDto, examples: WalletExamples.createRequest }),
    ApiResponse({ status: HttpStatus.CREATED, type: WalletResponse, content: { 'application/json': { example: WalletExamples.wallet } } }),
    invalidPayload(WagerExamples.validationError),
    errorResponse(HttpStatus.CONFLICT, 'Já existe wallet para playerId + currency', WalletExamples.duplicated),
    unavailable(),
  );

export const ApiGetWallet = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta uma wallet' }),
    walletIdParam(),
    ApiResponse({ status: HttpStatus.OK, type: WalletResponse, content: { 'application/json': { example: WalletExamples.wallet } } }),
    invalidPayload(),
    notFound(),
  );

export const ApiListLedger = () =>
  applyDecorators(
    ApiOperation({ summary: 'Lista o ledger da wallet', description: 'Paginação por cursor opaco e estável, do lançamento mais recente para o mais antigo.' }),
    walletIdParam(),
    ApiResponse({ status: HttpStatus.OK, type: LedgerPageResponse, content: { 'application/json': { example: WalletExamples.ledgerPage } } }),
    invalidPayload(WalletExamples.invalidCursor),
    notFound(),
  );

export const ApiReconcileWallet = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Reconcilia saldo materializado com o ledger',
      description: 'Divergências não são corrigidas: são logadas, contabilizadas em métrica e sinalizadas com consistent=false.',
    }),
    walletIdParam(),
    ApiResponse({ status: HttpStatus.OK, type: ReconciliationResponse, content: { 'application/json': { example: WalletExamples.reconciliation } } }),
    invalidPayload(),
    notFound(),
  );

export const ApiSubmitWagerTransaction = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Submete uma transação de aposta',
      description:
        'Idempotente pela Idempotency-Key. Requisição idêntica devolve o resultado original com idempotentReplay=true; mesma key com payload diferente é conflito (409).',
    }),
    ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Fonte da verdade da idempotência. Padrão recomendado: {providerId}:{externalTransactionId}', example: 'provider-a:transaction-123' }),
    ApiHeader({ name: 'X-Correlation-Id', required: false, description: 'Propagado nos logs e eventos; gerado se ausente' }),
    ApiBody({ type: SubmitWagerTransactionDto, examples: WagerExamples.submitRequest }),
    ApiResponse({ status: HttpStatus.CREATED, description: 'Transação aplicada', type: WagerTransactionResultResponse, content: { 'application/json': { example: WagerExamples.processed } } }),
    ApiResponse({ status: HttpStatus.OK, description: 'Replay idempotente de transação já aplicada', type: WagerTransactionResultResponse, content: { 'application/json': { example: WagerExamples.replay } } }),
    ApiResponse({
      status: HttpStatus.ACCEPTED,
      description: 'Aceita, aguardando a transação referenciada (PENDING_REFERENCE)',
      type: WagerTransactionResultResponse,
      content: { 'application/json': { example: WagerExamples.pendingReference } },
    }),
    errorResponse(HttpStatus.BAD_REQUEST, 'Payload inválido ou Idempotency-Key ausente; corrigir antes de reenviar', WagerExamples.validationError),
    errorResponse(HttpStatus.CONFLICT, 'Conflito de idempotência; não reenviar com a mesma key', WagerExamples.idempotencyConflict),
    ApiResponse({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      description: 'Rejeitada por regra de negócio (failureCode); reenviar não muda o resultado',
      type: WagerTransactionResultResponse,
      content: { 'application/json': { examples: WagerExamples.rejected } },
    }),
    unavailable(),
    errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, 'Falha permanente; reenviar a mesma requisição não resolve', WagerExamples.permanentFailure),
  );

export const ApiGetWagerTransaction = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta uma transação pelo id interno' }),
    ApiParam({ name: 'transactionId', format: 'uuid' }),
    ApiResponse({ status: HttpStatus.OK, type: WagerTransactionResponse, content: { 'application/json': { example: WagerExamples.transaction } } }),
    invalidPayload(),
    notFound(),
  );

export const ApiGetWagerTransactionByExternalId = () =>
  applyDecorators(
    ApiOperation({ summary: 'Consulta uma transação pelo id do provedor' }),
    ApiParam({ name: 'providerId', example: 'provider-a' }),
    ApiParam({ name: 'externalTransactionId', example: 'transaction-123' }),
    ApiResponse({ status: HttpStatus.OK, type: WagerTransactionResponse, content: { 'application/json': { example: WagerExamples.transaction } } }),
    invalidPayload(),
    notFound(),
  );
