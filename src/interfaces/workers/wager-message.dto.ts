import { plainToInstance, Type } from "class-transformer";
import {
  Equals,
  IsDefined,
  IsISO8601,
  IsString,
  Length,
  Matches,
  ValidateNested,
  validate,
} from "class-validator";
import { InvalidArgumentError } from "../../domain/shared/domain-error";
import {
  IDENTIFIER_PATTERN,
  WagerTransactionPayloadDto,
} from "../http/dto/wager.dto";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

// Mesmos campos de negócio da entrada HTTP, mais a idempotency key que no HTTP vem no header
export class WagerTransactionMessageDataDto extends WagerTransactionPayloadDto {
  @IsString()
  @Length(1, 255)
  @Matches(IDENTIFIER_PATTERN)
  idempotencyKey!: string;
}

export class WagerTransactionMessageDto {
  @IsString()
  @Length(1, 255)
  messageId!: string;

  @Equals(WAGER_MESSAGE_TYPE)
  type!: typeof WAGER_MESSAGE_TYPE;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerTransactionMessageDataDto)
  data!: WagerTransactionMessageDataDto;
}

// Payload que não passa no contrato é erro permanente: reenviar a mesma mensagem nunca vai funcionar
export class InvalidWagerMessageError extends InvalidArgumentError {}

export async function parseWagerMessage(
  body: string | undefined,
): Promise<WagerTransactionMessageDto> {
  let raw: unknown;

  try {
    raw = JSON.parse(body ?? "");
  } catch {
    throw new InvalidWagerMessageError("Message body is not valid JSON");
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new InvalidWagerMessageError("Message body must be a JSON object");

  const message = plainToInstance(WagerTransactionMessageDto, raw);
  const errors = await validate(message, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    const fields = errors.map((error) => error.property).join(", ");
    throw new InvalidWagerMessageError(`Invalid message fields: ${fields}`);
  }

  return message;
}
