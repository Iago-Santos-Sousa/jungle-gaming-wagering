import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { AMOUNT_PATTERN, CURRENCY_PATTERN, type MoneyProps } from '../../../domain/money/money';

// Contrato monetário de entrada: string decimal não negativa com até 2 casas, nunca number
export class MoneyDto implements MoneyProps {
  @ApiProperty({ description: 'Valor decimal em string, até 2 casas, não negativo', example: '25.00', pattern: AMOUNT_PATTERN.source })
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: 'amount must be a non-negative decimal string with up to 2 decimal places' })
  amount!: string;

  @ApiProperty({ description: 'Código ISO-4217', example: 'BRL', pattern: CURRENCY_PATTERN.source })
  @IsString()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
}

// Contrato monetário de saída: sempre com escala fixa de 2 casas
export class MoneyResponse implements MoneyProps {
  @ApiProperty({ example: '975.00' })
  amount!: string;

  @ApiProperty({ example: 'BRL' })
  currency!: string;
}
