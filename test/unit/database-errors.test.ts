import { describe, expect, test } from 'bun:test';
import { isPermanentDatabaseError, isTransientDatabaseError } from '../../src/infrastructure/database/database-errors';

// Erro no formato do driver pg: SQLSTATE no campo code
const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe('classificação de erros do banco', () => {
  test.each([
    ['22003', 'numeric_value_out_of_range'],
    ['22P02', 'invalid_text_representation'],
    ['23514', 'check_violation'],
    ['23503', 'foreign_key_violation'],
  ])('%s (%s) é permanente e não transitório', (code) => {
    expect(isPermanentDatabaseError(pgError(code))).toBe(true);
    expect(isTransientDatabaseError(pgError(code))).toBe(false);
  });

  test.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
    ['55P03', 'lock_not_available'],
  ])('%s (%s) é transitório e não permanente', (code) => {
    expect(isPermanentDatabaseError(pgError(code))).toBe(false);
    expect(isTransientDatabaseError(pgError(code))).toBe(true);
  });

  test('23505 (unique_violation) não é permanente: corrida de inserção se resolve relendo', () => {
    expect(isPermanentDatabaseError(pgError('23505'))).toBe(false);
  });

  test('erro sem SQLSTATE não é classificado como permanente', () => {
    expect(isPermanentDatabaseError(new Error('boom'))).toBe(false);
    expect(isPermanentDatabaseError('not an error')).toBe(false);
  });
});
