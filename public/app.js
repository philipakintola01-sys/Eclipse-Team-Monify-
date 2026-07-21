const SAMPLE_CSV = `name,score,accountNumber,bankCode
Ada Lovelace,95,0123456789,058
Grace Hopper,88,0987654321,044
Alan Turing,82,1122334455,011
Katherine Johnson,91,5566778899,033`;

const ERROR_MESSAGES = {
  VALIDATION_ERROR: 'Check your pool amount, rule, or CSV data and try again.',
  CSV_PARSE_ERROR: 'Your CSV is missing required columns or rows.',
  CONFIG_ERROR: 'Server configuration is incomplete. Check API keys in .env.',
  AI_UNAVAILABLE: 'Groq is unavailable. The server will use the fallback split.',
  AI_INVALID_OUTPUT: 'Groq returned invalid output. The server will use the fallback split.',
  MONNIFY_AUTH_FAILED: 'Monnify authentication failed. Verify sandbox API keys.',
  MONNIFY_NETWORK_ERROR: 'Could not reach Monnify. Check your internet connection.',
  MONNIFY_INSUFFICIENT_BALANCE: 'Monnify wallet balance is too low for this payout.',
  MONNIFY_INVALID_ACCOUNT: 'One or more bank account details are invalid.',
  MONNIFY_DUPLICATE_REFERENCE: 'Duplicate transfer reference. Retry the payout.',
  MONNIFY_DISBURSEMENT_FAILED: 'Monnify could not complete one or more transfers.',
  MONNIFY_PENDING_AUTHORIZATION: 'Transfer created — awaiting Monnify OTP in sandbox.',
  PAYOUT_MISSING_BANK_DETAILS: 'Every recipient needs account number, bank code, and account name.',
  PAYOUT_EMPTY: 'Generate an allocation preview before paying out.',
  INTERNAL_ERROR: 'Unexpected server error. Check the terminal logs.',
};

let rules = {};
let participants = [];
let currentAllocation = null;

const setupForm = document.getElementById('setup-form');
const ruleSelect = document.getElementById('rule');
const ruleParamsEl = document.getElementById('rule-params');
const csvFileInput = document.getElementById('csv-file');
const stepSetup = document.getElementById('step-setup');
const stepPreview = document.getElementById('step-preview');
const stepResults = document.getElementById('step-results');
const previewBody = document.getElementById('preview-body');
const previewStats = document.getElementById('preview-stats');
const previewMeta = document.getElementById('preview-meta');
const previewWarnings = document.getElementById('preview-warnings');
const resultBody = document.getElementById('result-body');
const resultStats = document.getElementById('result-stats');
const resultWarnings = document.getElementById('result-warnings');
const toast = document.getElementById('toast');

function showToast(message, type = 'error') {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4500);
}

function showBanner(element, messages, type = 'warn') {
  if (!element) return;

  if (!messages?.length) {
    element.classList.add('hidden');
    element.innerHTML = '';
    return;
  }

  element.className = `alert-banner ${type}`;
  element.innerHTML = messages.map((msg) => `<div>${msg}</div>`).join('');
  element.classList.remove('hidden');
}

function friendlyError(data, fallback = 'Something went wrong') {
  const code = data?.code;
  const base = data?.error || fallback;
  const hint = ERROR_MESSAGES[code];
  const details = data?.details?.missing?.length
    ? ` Missing: ${data.details.missing.join(', ')}.`
    : '';

  return hint ? `${base} ${hint}${details}` : `${base}${details}`;
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('CSV must include a header row and at least one participant');
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  const scoreIdx = headers.indexOf('score');
  const accountIdx = headers.indexOf('accountnumber');
  const bankIdx = headers.indexOf('bankcode');

  if (nameIdx === -1 || scoreIdx === -1) {
    throw new Error('CSV must include name and score columns');
  }

  return lines.slice(1).map((line, index) => {
    const cols = line.split(',').map((c) => c.trim());
    const score = Number(cols[scoreIdx]);

    if (!cols[nameIdx]) {
      throw new Error(`Row ${index + 2} is missing a participant name`);
    }

    if (!Number.isFinite(score)) {
      throw new Error(`Row ${index + 2} has an invalid score for ${cols[nameIdx]}`);
    }

    return {
      name: cols[nameIdx],
      score,
      accountNumber: accountIdx >= 0 ? cols[accountIdx] || '' : '',
      bankCode: bankIdx >= 0 ? cols[bankIdx] || '' : '',
      accountName: cols[nameIdx],
    };
  });
}

async function readCsvFile(file) {
  const text = await file.text();
  return parseCsv(text);
}

function renderRuleParams(ruleKey) {
  ruleParamsEl.innerHTML = '';
  const template = rules[ruleKey];
  if (!template?.params?.length) return;

  for (const param of template.params) {
    const label = document.createElement('label');
    label.innerHTML = `
      ${param.label}
      <input
        type="${param.type || 'number'}"
        name="${param.key}"
        value="${param.default ?? ''}"
        required
      />
    `;
    ruleParamsEl.appendChild(label);
  }
}

function getRuleParams() {
  const params = {};
  ruleParamsEl.querySelectorAll('input[name]').forEach((input) => {
    params[input.name] = Number(input.value);
  });
  return params;
}

function showStep(step) {
  stepSetup.classList.toggle('hidden', step !== 'setup');
  stepPreview.classList.toggle('hidden', step !== 'preview');
  stepResults.classList.toggle('hidden', step !== 'results');
}

function renderPreview(allocation) {
  previewMeta.textContent =
    allocation.source === 'ai'
      ? 'AI-generated proposal. Confirm only after reviewing every line.'
      : 'AI was unavailable — server used the deterministic fallback split.';

  const warnings = [...(allocation.warnings || [])];
  if (allocation.source === 'fallback' && allocation.aiError) {
    warnings.unshift(`Fallback reason: ${allocation.aiError}`);
  }

  showBanner(previewWarnings, warnings, allocation.source === 'fallback' ? 'warn' : 'info');

  previewStats.innerHTML = `
    <div class="stat">
      <div class="stat-label">Pool</div>
      <div class="stat-value">${formatMoney(allocation.pool)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Allocated</div>
      <div class="stat-value">${formatMoney(allocation.total)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Recipients</div>
      <div class="stat-value">${allocation.allocations.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Source</div>
      <div class="stat-value">
        <span class="badge ${allocation.source === 'ai' ? 'ai' : 'fallback'}">${allocation.source}</span>
      </div>
    </div>
  `;

  previewBody.innerHTML = allocation.allocations
    .map(
      (item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.score ?? '—'}</td>
        <td>${formatMoney(item.amount)}</td>
        <td>${item.accountNumber || '—'}</td>
        <td>${item.bankCode || '—'}</td>
      </tr>
    `
    )
    .join('');
}

function renderResults(summary) {
  resultStats.innerHTML = `
    <div class="stat">
      <div class="stat-label">Requested</div>
      <div class="stat-value">${formatMoney(summary.totalRequested)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Successful</div>
      <div class="stat-value">${summary.successCount || 0}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pending</div>
      <div class="stat-value">${summary.pendingCount || 0}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Failed</div>
      <div class="stat-value">${summary.failCount || 0}</div>
    </div>
  `;

  const warnings = [...(summary.warnings || [])];
  if (summary.partial) {
    warnings.unshift('Some transfers failed while others were initiated. Review each row below.');
  }
  if (summary.allFailed) {
    showBanner(resultWarnings, [summary.error || 'All transfers failed.', ...warnings], 'error');
  } else {
    showBanner(resultWarnings, warnings, summary.pendingCount ? 'warn' : 'info');
  }

  resultBody.innerHTML = summary.results
    .map(
      (item) => `
      <tr>
        <td>${item.name}</td>
        <td>${formatMoney(item.amount)}</td>
        <td>
          <span class="badge ${
            item.status === 'PENDING_AUTHORIZATION'
              ? 'fallback'
              : item.success
                ? 'success'
                : 'fail'
          }">
            ${item.status || (item.success ? 'SUCCESS' : 'FAILED')}
          </span>
        </td>
        <td>${item.message || item.reference || '—'}</td>
      </tr>
    `
    )
    .join('');
}

async function loadRules() {
  const response = await fetch('/api/rules');
  if (!response.ok) {
    throw new Error('Could not load allocation rules from the server');
  }
  rules = await response.json();

  ruleSelect.innerHTML = Object.entries(rules)
    .map(([key, template]) => `<option value="${key}">${template.label}</option>`)
    .join('');

  renderRuleParams(ruleSelect.value);
}

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    if (!csvFileInput.files?.[0]) {
      throw new Error('Please upload a CSV file');
    }

    participants = await readCsvFile(csvFileInput.files[0]);
    const payload = {
      pool: Number(document.getElementById('pool').value),
      rule: ruleSelect.value,
      ruleParams: getRuleParams(),
      participants,
    };

    const button = setupForm.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Generating preview...';

    const response = await fetch('/api/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(friendlyError(data, 'Allocation failed'));
    }

    currentAllocation = data;
    renderPreview(data);
    showStep('preview');

    if (data.source === 'fallback') {
      showToast('Preview generated using fallback split', 'warn');
    } else {
      showToast('AI preview generated successfully', 'success');
    }
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    const button = setupForm.querySelector('button[type="submit"]');
    button.disabled = false;
    button.textContent = 'Generate AI preview';
  }
});

document.getElementById('confirm-pay').addEventListener('click', async () => {
  const button = document.getElementById('confirm-pay');
  button.disabled = true;
  button.textContent = 'Processing payouts...';

  try {
    const response = await fetch('/api/payout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations: currentAllocation.allocations }),
    });

    const data = await response.json();

    renderResults(data);
    showStep('results');

    if (!response.ok || data.allFailed) {
      showToast(friendlyError(data, 'Payout failed'), 'error');
      return;
    }

    if (data.partial) {
      showToast('Payout completed with some failures', 'warn');
      return;
    }

    if (data.pendingCount) {
      showToast('Transfers initiated — some are pending Monnify OTP', 'warn');
      return;
    }

    showToast('All transfers completed successfully', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Confirm & pay';
  }
});

document.getElementById('back-to-setup').addEventListener('click', () => showStep('setup'));
document.getElementById('start-over').addEventListener('click', () => {
  currentAllocation = null;
  showBanner(previewWarnings, []);
  showBanner(resultWarnings, []);
  showStep('setup');
});

document.getElementById('load-sample').addEventListener('click', () => {
  const file = new File([SAMPLE_CSV], 'sample-participants.csv', { type: 'text/csv' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  csvFileInput.files = dataTransfer.files;
  showToast('Sample CSV loaded', 'success');
});

ruleSelect.addEventListener('change', () => renderRuleParams(ruleSelect.value));

loadRules().catch((error) => showToast(error.message, 'error'));
