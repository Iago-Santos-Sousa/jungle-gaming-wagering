import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { LedgerDirection } from "../../../domain/ledger/ledger-direction";
import { MoneyDto, MoneyResponse } from "./money.dto";

export class CreateWalletDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  playerId!: string;

  @ApiProperty({
    type: MoneyDto,
    description:
      "Saldo inicial; quando maior que zero gera a transação interna OPENING",
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class WalletIdParam {
  @IsUUID()
  walletId!: string;
}

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 100;

export class LedgerQueryDto {
  @ApiPropertyOptional({ description: "Cursor opaco devolvido em nextCursor" })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LEDGER_MAX_LIMIT,
    default: LEDGER_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEDGER_MAX_LIMIT)
  limit: number = LEDGER_DEFAULT_LIMIT;
}

export class WalletResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  playerId!: string;

  @ApiProperty({ type: MoneyResponse })
  balance!: MoneyResponse;

  @ApiProperty({
    description: "Inicia em 1 e incrementa somente quando o saldo muda",
  })
  version!: number;
}

export class LedgerEntryResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  transactionId!: string;

  @ApiProperty({ enum: LedgerDirection })
  direction!: LedgerDirection;

  @ApiProperty({ type: MoneyResponse })
  money!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse })
  balanceBefore!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse })
  balanceAfter!: MoneyResponse;

  @ApiProperty({
    description:
      "Versão da wallet após o lançamento (posição estável no ledger)",
  })
  walletVersion!: number;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class LedgerPageResponse {
  @ApiProperty({ type: [LedgerEntryResponse] })
  items!: LedgerEntryResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Cursor da próxima página; null quando não há mais itens",
  })
  nextCursor!: string | null;
}

export class ReconciliationResponse {
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  @ApiProperty({ type: MoneyResponse })
  storedBalance!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse })
  calculatedBalance!: MoneyResponse;

  @ApiProperty({
    type: MoneyResponse,
    description: "storedBalance menos calculatedBalance",
  })
  difference!: MoneyResponse;

  @ApiProperty()
  consistent!: boolean;

  @ApiProperty()
  checkedEntries!: number;
}
