require('dotenv').config();

const { AppError, ERROR_CODES } = require('./errors');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const RULE_TEMPLATES = {
  top_n_equal: {
    label: 'Top N — equal split',
    description: 'Split the pool equally among the top N participants by score.',
    params: [{ key: 'topN', label: 'Top N', type: 'number', default: 3 }],
  },
  top_n_weighted: {
    label: 'Top N — weighted by score',
    description: 'Split the pool among top N participants proportional to their scores.',
    params: [{ key: 'topN', label: 'Top N', type: 'number', default: 3 }],
  },
  threshold_bonus: {
    label: 'Score threshold bonus',
    description: 'Everyone above the threshold gets an equal share; remainder goes to highest scorer.',
    params: [
      { key: 'threshold', label: 'Min score', type: 'number', default: 70 },
      { key: 'bonusPercent', label: 'Top bonus %', type: 'number', default: 20 },
    ],
  },
};

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildPrompt(pool, rule, ruleParams, participants) {
  const template = RULE_TEMPLATES[rule] || { label: rule, description: rule };

  return `You are a payout allocation engine. Return ONLY valid JSON — no markdown, no explanation.

Pool amount (NGN): ${pool}
Rule: ${template.label}
Rule description: ${template.description}
Rule parameters: ${JSON.stringify(ruleParams)}

Participants (name, score):
${participants.map((p) => `- ${p.name}: score ${p.score}`).join('\n')}

Return a JSON array of objects with exactly these fields:
[{"name": "Participant Name", "amount": 1234.56}]

Rules:
- Use only participant names from the list above (exact match).
- All amounts must be positive numbers with at most 2 decimal places.
- Total of all amounts must be <= ${pool}.
- Prefer using the full pool when the rule allows.
- Do not include bank details in the response.`;
}

function extractJsonArray(text) {
  if (!text) {
    throw new Error('Empty AI response');
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.trim();

  const parsed = JSON.parse(candidate);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.allocations)) {
    return parsed.allocations;
  }

  if (Array.isArray(parsed.payouts)) {
    return parsed.payouts;
  }

  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI response did not contain a JSON array');
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function validateAllocation(allocations, pool, participants) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { valid: false, error: 'Allocation must be a non-empty array' };
  }

  const nameSet = new Set(participants.map((p) => p.name.trim().toLowerCase()));
  let total = 0;

  for (const item of allocations) {
    const amount = Number(item.amount);
    const name = String(item.name || '').trim();

    if (!name || !nameSet.has(name.toLowerCase())) {
      return { valid: false, error: `Unknown participant in allocation: ${name || '(blank)'}` };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { valid: false, error: `Invalid amount for ${name}` };
    }

    total += amount;
  }

  total = roundMoney(total);
  const poolAmount = roundMoney(pool);

  if (total > poolAmount + 0.01) {
    return {
      valid: false,
      error: `Allocation total (${total}) exceeds pool (${poolAmount})`,
    };
  }

  return { valid: true, total };
}

function fallbackAllocate(pool, rule, ruleParams, participants) {
  const poolAmount = roundMoney(pool);
  const sorted = [...participants].sort((a, b) => b.score - a.score);

  if (rule === 'threshold_bonus') {
    const threshold = Number(ruleParams.threshold ?? 70);
    const bonusPercent = Number(ruleParams.bonusPercent ?? 20) / 100;
    const qualifiers = sorted.filter((p) => p.score >= threshold);

    if (qualifiers.length === 0) {
      return [{ name: sorted[0].name, amount: poolAmount }];
    }

    const bonus = roundMoney(poolAmount * bonusPercent);
    const remainder = roundMoney(poolAmount - bonus);
    const share = roundMoney(remainder / qualifiers.length);

    const allocations = qualifiers.map((p) => ({ name: p.name, amount: share }));
    allocations[0] = {
      name: sorted[0].name,
      amount: roundMoney((allocations.find((a) => a.name === sorted[0].name)?.amount || 0) + bonus),
    };

    return normalizeTotal(allocations, poolAmount);
  }

  const topN = Math.max(1, Number(ruleParams.topN ?? 3));
  const winners = sorted.slice(0, Math.min(topN, sorted.length));

  if (rule === 'top_n_weighted') {
    const scoreSum = winners.reduce((sum, p) => sum + p.score, 0) || 1;
    const allocations = winners.map((p) => ({
      name: p.name,
      amount: roundMoney((p.score / scoreSum) * poolAmount),
    }));
    return normalizeTotal(allocations, poolAmount);
  }

  const share = roundMoney(poolAmount / winners.length);
  return normalizeTotal(
    winners.map((p) => ({ name: p.name, amount: share })),
    poolAmount
  );
}

function normalizeTotal(allocations, poolAmount) {
  const total = roundMoney(allocations.reduce((sum, item) => sum + item.amount, 0));
  const diff = roundMoney(poolAmount - total);

  if (Math.abs(diff) >= 0.01 && allocations.length > 0) {
    allocations[0].amount = roundMoney(allocations[0].amount + diff);
  }

  return allocations;
}

function enrichAllocations(allocations, participants) {
  const byName = new Map(
    participants.map((p) => [p.name.trim().toLowerCase(), p])
  );

  return allocations.map((item) => {
    const participant = byName.get(String(item.name).trim().toLowerCase());
    return {
      name: item.name,
      amount: roundMoney(item.amount),
      accountNumber: participant?.accountNumber || '',
      bankCode: participant?.bankCode || '',
      accountName: participant?.accountName || participant?.name || item.name,
      score: participant?.score ?? null,
    };
  });
}

async function callGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AppError(
      ERROR_CODES.CONFIG_ERROR,
      'GROQ_API_KEY must be set in .env',
      500
    );
  }

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a payout allocation engine. Respond only with valid JSON — a JSON array of objects with name and amount fields.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || response.statusText;
    throw new AppError(ERROR_CODES.AI_UNAVAILABLE, `Groq request failed: ${message}`, 502);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Groq returned no text content');
  }

  return text;
}

async function allocate(pool, rule, ruleParams, participants) {
  const prompt = buildPrompt(pool, rule, ruleParams, participants);
  let source = 'ai';
  let allocations = [];
  let warnings = [];
  let aiError = null;

  try {
    const raw = await callGroq(prompt);
    allocations = extractJsonArray(raw);
    const validation = validateAllocation(allocations, pool, participants);

    if (!validation.valid) {
      throw new AppError(
        ERROR_CODES.AI_INVALID_OUTPUT,
        validation.error || 'AI returned an invalid allocation',
        502
      );
    }
  } catch (error) {
    source = 'fallback';
    aiError = error instanceof AppError ? error.message : error.message;
    warnings.push('Groq allocation failed or was invalid — deterministic fallback split was used.');
    allocations = fallbackAllocate(pool, rule, ruleParams, participants);
  }

  const enriched = enrichAllocations(allocations, participants);
  const total = roundMoney(enriched.reduce((sum, item) => sum + item.amount, 0));

  return {
    source,
    aiError,
    warnings,
    rule,
    ruleParams,
    pool: roundMoney(pool),
    total,
    allocations: enriched,
  };
}

module.exports = {
  RULE_TEMPLATES,
  allocate,
  validateAllocation,
  fallbackAllocate,
  buildPrompt,
  extractJsonArray,
};

// Standalone test: node ai.js
if (require.main === module) {
  const testParticipants = [
    { name: 'Ada Lovelace', score: 95, accountNumber: '0123456789', bankCode: '058' },
    { name: 'Grace Hopper', score: 88, accountNumber: '0987654321', bankCode: '044' },
    { name: 'Alan Turing', score: 82, accountNumber: '1122334455', bankCode: '011' },
    { name: 'Katherine Johnson', score: 91, accountNumber: '5566778899', bankCode: '033' },
  ];

  allocate(100000, 'top_n_weighted', { topN: 3 }, testParticipants)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error('AI allocation failed:', error.message);
      process.exit(1);
    });
}
