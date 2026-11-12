// Taxonomia estável de falhas. O provedor decide reenviar, corrigir ou desistir a partir do código.
export enum FailureCode {
  // Aposta maior que o saldo disponível. Reenviar igual não muda o resultado.
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  // Reversão (ROLLBACK de WIN ou de REFUND) deixaria o saldo negativo. Exige ação operacional.
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  // Referência não chegou dentro do limite de tentativas
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  // Referência de outro player, wallet, rodada ou moeda
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  // Crédito levaria o saldo além do limite armazenável. Reenviar igual não muda o resultado.
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  // Erro permanente de infraestrutura registrado para auditoria
  InternalError = 'INTERNAL_ERROR',
}
