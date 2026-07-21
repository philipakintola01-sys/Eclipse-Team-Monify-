/**
 * Structured application errors for consistent API responses.
 */
class AppError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CSV_PARSE_ERROR: 'CSV_PARSE_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_INVALID_OUTPUT: 'AI_INVALID_OUTPUT',
  MONNIFY_AUTH_FAILED: 'MONNIFY_AUTH_FAILED',
  MONNIFY_NETWORK_ERROR: 'MONNIFY_NETWORK_ERROR',
  MONNIFY_INSUFFICIENT_BALANCE: 'MONNIFY_INSUFFICIENT_BALANCE',
  MONNIFY_INVALID_ACCOUNT: 'MONNIFY_INVALID_ACCOUNT',
  MONNIFY_DUPLICATE_REFERENCE: 'MONNIFY_DUPLICATE_REFERENCE',
  MONNIFY_DISBURSEMENT_FAILED: 'MONNIFY_DISBURSEMENT_FAILED',
  MONNIFY_PENDING_AUTHORIZATION: 'MONNIFY_PENDING_AUTHORIZATION',
  PAYOUT_MISSING_BANK_DETAILS: 'PAYOUT_MISSING_BANK_DETAILS',
  PAYOUT_EMPTY: 'PAYOUT_EMPTY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

function isNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.name === 'TypeError' &&
    (message.includes('fetch failed') || message.includes('network'))
  );
}

function classifyMonnifyError(error, context = {}) {
  const message = String(error?.message || 'Monnify request failed');
  const lower = message.toLowerCase();

  if (isNetworkError(error)) {
    return new AppError(
      ERROR_CODES.MONNIFY_NETWORK_ERROR,
      'Could not reach Monnify. Check your internet connection and try again.',
      503,
      { context, originalMessage: message }
    );
  }

  if (lower.includes('insufficient') || lower.includes('d04')) {
    return new AppError(
      ERROR_CODES.MONNIFY_INSUFFICIENT_BALANCE,
      'Insufficient Monnify wallet balance for this payout.',
      402,
      { context, originalMessage: message }
    );
  }

  if (
    lower.includes('invalid account') ||
    lower.includes('account number') ||
    lower.includes('d03') ||
    lower.includes('name mismatch')
  ) {
    return new AppError(
      ERROR_CODES.MONNIFY_INVALID_ACCOUNT,
      'Invalid bank account details for one or more recipients.',
      400,
      { context, originalMessage: message }
    );
  }

  if (lower.includes('already been used') || lower.includes('d05') || lower.includes('duplicate')) {
    return new AppError(
      ERROR_CODES.MONNIFY_DUPLICATE_REFERENCE,
      'Duplicate transfer reference detected. Retry the payout.',
      409,
      { context, originalMessage: message }
    );
  }

  if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('401')) {
    return new AppError(
      ERROR_CODES.MONNIFY_AUTH_FAILED,
      'Monnify authentication failed. Check API keys in .env.',
      401,
      { context, originalMessage: message }
    );
  }

  return new AppError(
    ERROR_CODES.MONNIFY_DISBURSEMENT_FAILED,
    message,
    502,
    { context, originalMessage: message }
  );
}

function sendError(res, error) {
  if (error instanceof AppError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details,
    });
  }

  return res.status(500).json({
    ok: false,
    code: ERROR_CODES.INTERNAL_ERROR,
    error: error?.message || 'Unexpected server error',
  });
}

function validateEnv() {
  const required = [
    'MONNIFY_API_KEY',
    'MONNIFY_SECRET_KEY',
    'MONNIFY_SOURCE_ACCOUNT',
    'GROQ_API_KEY',
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn(`[AutoPay] Missing env vars: ${missing.join(', ')}`);
    console.warn('[AutoPay] Some features will fail until .env is configured.');
  }
}

module.exports = {
  AppError,
  ERROR_CODES,
  classifyMonnifyError,
  isNetworkError,
  sendError,
  validateEnv,
};
