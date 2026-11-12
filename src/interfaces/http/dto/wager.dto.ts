import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from "class-validator";
import { FailureCode } from "../../../domain/wager-transaction/failure-code";
import {
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
  WagerTransactionStatus,
  type SubmittableKind,
} from "../../../domain/wager-transaction/wager-transaction";
import { MoneyDto, MoneyResponse } from "./money.dto";

// Identificadores de provedor: sem espaços nem caracteres de controle
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:\-]+$/;
const IDENTIFIER_MESSAGE =
  'must contain only letters, digits, ".", "_", ":" or "-"';

// Campos de negócio comuns à entrada HTTP e à mensagem SQS
export class WagerTransactionPayloadDto {
  @ApiProperty({ example: "provider-a", maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @Matches(IDENTIFIER_PATTERN, { message: `providerId ${IDENTIFIER_MESSAGE}` })
  providerId!: string;

  @ApiProperty({ example: "transaction-123", maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER_PATTERN, {
    message: `externalTransactionId ${IDENTIFIER_MESSAGE}`,
  })
  externalTransactionId!: string;

  @ApiProperty({ format: "uuid" })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ format: "uuid" })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: "round-987", maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER_PATTERN, { message: `roundId ${IDENTIFIER_MESSAGE}` })
  roundId!: string;

  @ApiProperty({ example: "fortune-chimp", maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER_PATTERN, { message: `gameId ${IDENTIFIER_MESSAGE}` })
  gameId!: string;

  @ApiProperty({
    enum: SUBMITTABLE_KINDS,
    description: "OPENING é interno e não pode ser submetido",
  })
  @IsIn(SUBMITTABLE_KINDS)
  kind!: SubmittableKind;

  @ApiProperty({ type: MoneyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    description:
      "externalTransactionId da transação referenciada (obrigatório para REFUND e ROLLBACK)",
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER_PATTERN, {
    message: `referenceExternalTransactionId ${IDENTIFIER_MESSAGE}`,
  })
  referenceExternalTransactionId?: string;
}

export class SubmitWagerTransactionDto extends WagerTransactionPayloadDto {}

export class TransactionIdParam {
  @IsUUID()
  transactionId!: string;
}

export class ExternalTransactionParams {
  @IsString()
  @Length(1, 64)
  @Matches(IDENTIFIER_PATTERN)
  providerId!: string;

  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER_PATTERN)
  externalTransactionId!: string;
}

export class WagerTransactionResultResponse {
  @ApiProperty({
    format: "uuid",
    nullable: true,
    type: String,
    description: "null quando nada foi persistido (WALLET_NOT_FOUND)",
  })
  transactionId!: string | null;

  @ApiProperty({ enum: WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @ApiProperty({
    type: MoneyResponse,
    nullable: true,
    description: "Saldo observado no momento da decisão",
  })
  balance!: MoneyResponse | null;

  @ApiPropertyOptional({
    enum: FailureCode,
    description: "Presente quando status é REJECTED ou FAILED",
  })
  failureCode?: FailureCode;

  @ApiProperty({
    description:
      "true quando a resposta é o resultado original de uma requisição repetida",
  })
  idempotentReplay!: boolean;
}

export class WagerTransactionResponse {
  @ApiProperty({ format: "uuid" })
  transactionId!: string;

  @ApiProperty()
  providerId!: string;

  @ApiProperty()
  externalTransactionId!: string;

  @ApiProperty({ format: "uuid" })
  walletId!: string;

  @ApiProperty({ format: "uuid" })
  playerId!: string;

  @ApiProperty({ type: String, nullable: true })
  roundId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gameId!: string | null;

  @ApiProperty({ enum: WagerTransactionKind })
  kind!: WagerTransactionKind;

  @ApiProperty({ type: MoneyResponse })
  money!: MoneyResponse;

  @ApiProperty({ enum: WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @ApiProperty({ enum: FailureCode, nullable: true })
  failureCode!: FailureCode | null;

  @ApiProperty({ type: String, nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  referenceTransactionId!: string | null;

  @ApiProperty({ type: MoneyResponse, nullable: true })
  balance!: MoneyResponse | null;

  @ApiProperty({ description: "Tentativas de resolver a referência" })
  referenceAttempts!: number;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextAttemptAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  processedAt!: string | null;
}

export class ErrorResponse {
  @ApiProperty({
    description: "Código estável e legível por máquina",
    example: "VALIDATION_ERROR",
  })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: [String] })
  details?: string[];

  @ApiProperty()
  correlationId!: string;
}
