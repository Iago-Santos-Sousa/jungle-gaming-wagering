import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CreateWalletUseCase,
  GetWalletUseCase,
  ListLedgerUseCase,
  ReconcileWalletUseCase,
} from "../../application/use-cases/wallet-use-cases";
import { Money } from "../../domain/money/money";
import {
  ApiCreateWallet,
  ApiGetWallet,
  ApiListLedger,
  ApiReconcileWallet,
} from "./docs/api-docs";
import {
  CreateWalletDto,
  LedgerQueryDto,
  WalletIdParam,
  type LedgerPageResponse,
  type ReconciliationResponse,
  type WalletResponse,
} from "./dto/wallet.dto";
import {
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
} from "./presenters";
import { CorrelationId } from "./request-context";

@ApiTags("wallets")
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateWallet()
  async create(
    @Body() body: CreateWalletDto,
    @CorrelationId() correlationId: string,
  ): Promise<WalletResponse> {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: Money.from(body.initialBalance),
      correlationId,
    });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  @ApiGetWallet()
  async get(@Param() { walletId }: WalletIdParam): Promise<WalletResponse> {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  @ApiListLedger()
  async ledger(
    @Param() { walletId }: WalletIdParam,
    @Query() query: LedgerQueryDto,
  ): Promise<LedgerPageResponse> {
    return presentLedgerPage(
      await this.listLedger.execute({
        walletId,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  @ApiReconcileWallet()
  async reconcile(
    @Param() { walletId }: WalletIdParam,
  ): Promise<ReconciliationResponse> {
    return presentReconciliation(await this.reconcileWallet.execute(walletId));
  }
}
