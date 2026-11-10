import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidArgumentError } from '../../src/domain/shared/domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('escala e serialização', () => {
    test.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['25.05', '25.05'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('"%s" serializa como "%s"', (input, expected) => {
      expect(brl(input).toString()).toBe(expected);
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    test('soma decimal sem erro de ponto flutuante', () => {
      expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
      expect(brl('1000000000000000.01').add(brl('0.02')).toString()).toBe('1000000000000000.03');
    });

    test('não arredonda: mais de 2 casas é rejeitado em vez de arredondado', () => {
      expect(() => brl('10.005')).toThrow(InvalidArgumentError);
      expect(() => brl('10.999')).toThrow(InvalidArgumentError);
    });

    test('negativo vira "-x.xx" e zero negativo serializa como "0.00"', () => {
      expect(brl('10.00').negate().toString()).toBe('-10.00');
      expect(brl('0.00').negate().toString()).toBe('0.00');
    });
  });

  describe('entradas inválidas', () => {
    test.each(['NaN', 'Infinity', '-Infinity', '1e3', '1E3', '', ' ', '10.', '.5', '-1.00', '+1.00', '01.00', '1,00', ' 1.00', '1.00 ', '0x10', '1000000000000000000.00'])(
      'rejeita "%s"',
      (amount) => {
        expect(() => brl(amount)).toThrow(InvalidArgumentError);
      },
    );

    test('rejeita amount que não é string', () => {
      expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidArgumentError);
    });

    test.each(['', 'brl', 'BR', 'BRLL', '123'])('rejeita moeda "%s"', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidArgumentError);
    });
  });

  describe('operações', () => {
    test('é imutável: operações retornam nova instância', () => {
      const original = brl('10.00');
      const sum = original.add(brl('5.00'));
      expect(original.toString()).toBe('10.00');
      expect(sum.toString()).toBe('15.00');
      expect(sum).not.toBe(original);
    });

    test('subtrai, compara e consulta sinal', () => {
      const result = brl('10.00').subtract(brl('25.50'));
      expect(result.toString()).toBe('-15.50');
      expect(result.isNegative()).toBe(true);
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
      expect(brl('10.0').equals(brl('10.00'))).toBe(true);
    });

    test('rehydrate aceita valores assinados vindos do banco', () => {
      expect(Money.rehydrate({ amount: '-12.30', currency: 'BRL' }).toString()).toBe('-12.30');
      expect(Money.rehydrate({ amount: '12.30', currency: 'BRL' }).toString()).toBe('12.30');
      expect(() => Money.rehydrate({ amount: '--1.00', currency: 'BRL' })).toThrow(InvalidArgumentError);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    test.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s entre moedas diferentes lança erro de domínio', (_, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });

    test('equals entre moedas diferentes é falso', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
    });
  });
});
