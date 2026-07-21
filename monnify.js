require('dotenv').config();

const { AppError, ERROR_CODES, classifyMonnifyError, isNetworkError } = require('./errors');

const BASE_URL = 'https://sandbox.monnify.com';

let cachedToken = null;
let tokenExpiresAt = 0;

function getCredentials() {
  const apiKey = process.env.MONNIFY_API_KEY;
  const secretKey = process.env.MONNIFY_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new AppError(
      ERROR_CODES.CONFIG_ERROR,
      'MONNIFY_API_KEY and MONNIFY_SECRET_KEY must be set in .env',
      500
    );
  }

  return { apiKey, secretKey };
}

function getBasicAuthHeader() {
  const { apiKey, secretKey } = getCredentials();
  const encoded = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
  return `Basic ${encoded}`;
}

async function monnifyRequest(path, options = {}) {
  let response;

  try {
    response = await fetch(`${BASE_URL}${path}`, options);
  } catch (error) {
    throw classifyMonnifyError(error, { path });
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.requestSuccessful === false) {
    const message = data.responseMessage || data.message || response.statusText;
    throw classifyMonnifyError(new Error(message), {
      path,
      status: response.status,
      responseMessage: message,
    });
  }

  return data;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  try {
    const data = await monnifyRequest('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        Authorization: getBasicAuthHeader(),
        'Content-Type': 'application/json',
      },
    });

    const token = data.responseBody?.accessToken;
    const expiresIn = Number(data.responseBody?.expiresIn || 3600);

    if (!token) {
      throw new AppError(
        ERROR_CODES.MONNIFY_AUTH_FAILED,
        'Monnify auth did not return an access token',
        502
      );
    }

    cachedToken = token;
    tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;
    return token;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw classifyMonnifyError(error, { operation: 'auth/login' });
  }
}

async function getWalletBalance() {
  const sourceAccount = process.env.MONNIFY_SOURCE_ACCOUNT;
  if (!sourceAccount) {
    throw new AppError(
      ERROR_CODES.CONFIG_ERROR,
      'MONNIFY_SOURCE_ACCOUNT must be set in .env',
      500
    );
  }

  return monnifyRequest(
    `/api/v2/disbursements/wallet-balance?accountNumber=${encodeURIComponent(sourceAccount)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
      },
    }
  ).then((data) => data.responseBody);
}

function buildReference(prefix = 'autopay') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapTransferStatus(status) {
  const successStatuses = new Set(['SUCCESS', 'COMPLETED']);
  const pendingStatuses = new Set([
    'PENDING',
    'IN_PROGRESS',
    'AWAITING_PROCESSING',
    'PENDING_AUTHORIZATION',
  ]);
  const failedStatuses = new Set(['FAILED', 'REVERSED', 'EXPIRED']);

  if (successStatuses.has(status)) {
    return { success: true, pending: false, code: null };
  }

  if (status === 'PENDING_AUTHORIZATION') {
    return {
      success: true,
      pending: true,
      code: ERROR_CODES.MONNIFY_PENDING_AUTHORIZATION,
    };
  }

  if (pendingStatuses.has(status)) {
    return { success: true, pending: true, code: null };
  }

  if (failedStatuses.has(status)) {
    return {
      success: false,
      pending: false,
      code: ERROR_CODES.MONNIFY_DISBURSEMENT_FAILED,
    };
  }

  return { success: false, pending: false, code: ERROR_CODES.MONNIFY_DISBURSEMENT_FAILED };
}

async function disburseSingle({
  amount,
  accountNumber,
  bankCode,
  accountName,
  narration,
  reference,
}) {
  const sourceAccount = process.env.MONNIFY_SOURCE_ACCOUNT;
  if (!sourceAccount) {
    throw new AppError(
      ERROR_CODES.CONFIG_ERROR,
      'MONNIFY_SOURCE_ACCOUNT must be set in .env',
      500
    );
  }

  if (!amount || Number(amount) <= 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      'Transfer amount must be greater than zero',
      400,
      { amount }
    );
  }

  if (!accountNumber || !bankCode || !accountName) {
    throw new AppError(
      ERROR_CODES.PAYOUT_MISSING_BANK_DETAILS,
      'Recipient bank details are incomplete',
      400,
      { accountNumber, bankCode, accountName }
    );
  }

  const payload = {
    amount: Number(amount),
    reference: reference || buildReference('payout'),
    narration: narration || 'AutoPay disbursement',
    destinationBankCode: String(bankCode),
    destinationAccountNumber: String(accountNumber),
    destinationAccountName: String(accountName),
    currency: 'NGN',
    sourceAccountNumber: String(sourceAccount),
    async: true,
  };

  const data = await monnifyRequest('/api/v2/disbursements/single', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const status =
    data.responseBody?.status || data.responseBody?.transactionStatus || 'UNKNOWN';
  const mapped = mapTransferStatus(status);

  return {
    reference: payload.reference,
    status,
    success: mapped.success,
    pending: mapped.pending,
    code: mapped.code,
    message:
      status === 'PENDING_AUTHORIZATION'
        ? 'Transfer initiated — awaiting Monnify OTP authorization in sandbox'
        : data.responseMessage || 'Transfer initiated',
    raw: data.responseBody,
  };
}

async function disburseAll(payouts) {
  const results = [];
  let successCount = 0;
  let pendingCount = 0;
  let failCount = 0;

  for (const payout of payouts) {
    try {
      const result = await disburseSingle({
        amount: payout.amount,
        accountNumber: payout.accountNumber,
        bankCode: payout.bankCode,
        accountName: payout.accountName || payout.name,
        narration: `AutoPay payout to ${payout.name}`,
        reference: buildReference(`pay-${payout.name.replace(/\s+/g, '-').toLowerCase()}`),
      });

      if (result.success && result.pending) pendingCount += 1;
      else if (result.success) successCount += 1;
      else failCount += 1;

      results.push({
        name: payout.name,
        amount: payout.amount,
        success: result.success,
        pending: result.pending,
        status: result.status,
        code: result.code,
        reference: result.reference,
        message: result.message,
      });
    } catch (error) {
      failCount += 1;
      const appError = error instanceof AppError ? error : classifyMonnifyError(error, {
        recipient: payout.name,
      });

      results.push({
        name: payout.name,
        amount: payout.amount,
        success: false,
        pending: false,
        status: 'FAILED',
        code: appError.code,
        message: appError.message,
      });
    }
  }

  return {
    results,
    successCount,
    pendingCount,
    failCount,
    partial: failCount > 0 && successCount + pendingCount > 0,
    allFailed: failCount === payouts.length,
  };
}

module.exports = {
  getAccessToken,
  getWalletBalance,
  disburseSingle,
  disburseAll,
  buildReference,
  mapTransferStatus,
};

if (require.main === module) {
  getAccessToken()
    .then((token) => {
      console.log('Monnify auth OK');
      console.log('Token preview:', token.slice(0, 24) + '...');
    })
    .catch((error) => {
      console.error('Monnify auth failed:', error.message);
      process.exit(1);
    });
}
