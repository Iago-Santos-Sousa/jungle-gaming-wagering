// Taxonomia estável de falhas. O provedor decide reenviar, corrigir ou desistir a partir do código.
export enum FailureCode {
  // Aposta maior que o saldo disponível. Reenviar igual não muda o resultado.
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  // Reversão (ROLLBACK de WIN ou de REFUND) deixaria o saldo negativo. Exige ação operacional.
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  // Moeda da operação diferente da moeda da wallet
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  // walletId inexistente
  WalletNotFound = 'WALLET_NOT_FOUND',
  // playerId da operação diferente do dono da wallet
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  // Referência não chegou dentro do limite de tentativas
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  // Referência de outro player, wallet, rodada ou moeda
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  // Tipo de referência não permitido (ex.: REFUND referenciando WIN)
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  // Referência existe mas foi rejeitada ou falhou
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  // Referência já revertida por outro REFUND ou ROLLBACK
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  // Valor da reversão diferente do valor da referência
  AmountMismatch = 'AMOUNT_MISMATCH',
  // Crédito levaria o saldo além do limite armazenável. Reenviar igual não muda o resultado.
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  // Erro permanente de infraestrutura registrado para auditoria
  InternalError = 'INTERNAL_ERROR',
}
