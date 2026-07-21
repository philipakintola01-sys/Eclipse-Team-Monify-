require('dotenv').config();

const express = require('express');
const path = require('path');
const { allocate, RULE_TEMPLATES } = require('./ai');
const { disburseAll, getWalletBalance } = require('./monnify');
const { AppError, ERROR_CODES, sendError, validateEnv } = require('./errors');

validateEnv();

const app = express();
const PORT = process.env.PORT || 3000;

const session = {
  lastAllocation: null,
  lastPayout: null,
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'autopay',
    providers: {
      monnify: Boolean(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
    },
  });
});

app.get('/api/rules', (_req, res) => {
  res.json(RULE_TEMPLATES);
});

app.get('/api/session', (_req, res) => {
  res.json({
    lastAllocation: session.lastAllocation,
    lastPayout: session.lastPayout,
  });
});

app.get('/api/wallet', async (_req, res) => {
  try {
    const balance = await getWalletBalance();
    res.json({ ok: true, balance });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/allocate', async (req, res) => {
  try {
    const { pool, rule, ruleParams = {}, participants } = req.body || {};

    if (!pool || Number(pool) <= 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Pool amount must be greater than 0',
        400
      );
    }

    if (!rule || !RULE_TEMPLATES[rule]) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Invalid or missing rule template',
        400,
        { allowedRules: Object.keys(RULE_TEMPLATES) }
      );
    }

    if (!Array.isArray(participants) || participants.length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Participants array is required',
        400
      );
    }

    const normalizedParticipants = participants.map((p, index) => {
      const name = String(p.name || `Participant ${index + 1}`).trim();
      const score = Number(p.score);

      if (!name) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Participant on row ${index + 1} is missing a name`,
          400
        );
      }

      if (!Number.isFinite(score)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Participant "${name}" has an invalid score`,
          400,
          { row: index + 1 }
        );
      }

      return {
        name,
        score,
        accountNumber: String(p.accountNumber || '').trim(),
        bankCode: String(p.bankCode || '').trim(),
        accountName: String(p.accountName || name).trim(),
      };
    });

    const result = await allocate(Number(pool), rule, ruleParams, normalizedParticipants);
    session.lastAllocation = result;

    res.json({ ok: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/payout', async (req, res) => {
  try {
    const allocations = req.body?.allocations || session.lastAllocation?.allocations;

    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new AppError(
        ERROR_CODES.PAYOUT_EMPTY,
        'No allocations to pay out. Generate a preview first.',
        400
      );
    }

    const missingBank = allocations.filter(
      (item) => !item.accountNumber || !item.bankCode || !item.accountName
    );

    if (missingBank.length > 0) {
      throw new AppError(
        ERROR_CODES.PAYOUT_MISSING_BANK_DETAILS,
        'Every payout needs accountNumber, bankCode, and accountName',
        400,
        { missing: missingBank.map((item) => item.name) }
      );
    }

    const payout = await disburseAll(allocations);
    const summary = {
      ok: !payout.allFailed,
      paidAt: new Date().toISOString(),
      totalRequested: allocations.reduce((sum, item) => sum + Number(item.amount), 0),
      successCount: payout.successCount,
      pendingCount: payout.pendingCount,
      failCount: payout.failCount,
      partial: payout.partial,
      allFailed: payout.allFailed,
      results: payout.results,
      warnings: payout.pendingCount
        ? [
            `${payout.pendingCount} transfer(s) are pending Monnify OTP authorization in sandbox.`,
          ]
        : [],
    };

    session.lastPayout = summary;

    if (payout.allFailed) {
      return res.status(502).json({
        ok: false,
        code: ERROR_CODES.MONNIFY_DISBURSEMENT_FAILED,
        error: 'All transfers failed. Check recipient bank details and Monnify wallet balance.',
        ...summary,
      });
    }

    res.json(summary);
  } catch (error) {
    sendError(res, error);
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    code: 'NOT_FOUND',
    error: 'Route not found',
  });
});

app.listen(PORT, () => {
  console.log(`AutoPay running at http://localhost:${PORT}`);
});
