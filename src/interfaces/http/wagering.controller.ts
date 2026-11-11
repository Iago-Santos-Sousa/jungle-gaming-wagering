import { Body, Controller, Get, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { GetWagerTransactionUseCase, SubmitWagerTransactionUseCase, type WagerOutcome } from '../../application/use-cases/wager-use-cases';
import { Money } from '../../domain/money/money';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { ApiGetWagerTransaction, ApiGetWagerTransactionByExternalId, ApiSubmitWagerTransaction } from './docs/api-docs';
import {
  ExternalTransactionParams,
  SubmitWagerTransactionDto,
  TransactionIdParam,
  type WagerTransactionResponse,
  type WagerTransactionResultResponse,
} from './dto/wager.dto';
import { presentOutcome, presentTransaction } from './presenters';
import { CorrelationId, IdempotencyKey } from './request-context';

// Status HTTP por resultado: o provedor decide reenviar sem interpretar mensagens
function statusFor(outcome: WagerOutcome): HttpStatus {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@ApiTags('wagering')
@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @ApiSubmitWagerTransaction()
  async submitTransaction(
    @Body() body: SubmitWagerTransactionDto,
    @IdempotencyKey() idempotencyKey: string,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerTransactionResultResponse> {
    const outcome = await this.submit.execute({ ...body, money: Money.from(body.money), idempotencyKey }, { source: 'http', correlationId });
    res.status(statusFor(outcome));
    return presentOutcome(outcome);
  }

  @Get('wagering/transactions/:transactionId')
  @ApiGetWagerTransaction()
  async byId(@Param() { transactionId }: TransactionIdParam): Promise<WagerTransactionResponse> {
    return presentTransaction(await this.getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiGetWagerTransactionByExternalId()
  async byExternalId(@Param() { providerId, externalTransactionId }: ExternalTransactionParams): Promise<WagerTransactionResponse> {
    return presentTransaction(await this.getTransaction.byExternalId(providerId, externalTransactionId));
  }
}
