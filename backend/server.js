import express from 'express';
import cors from 'cors';
import dns from 'dns';
import net from 'net';
import { promisify } from 'util';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const resolveMx = promisify(dns.resolveMx);
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// LEVEL 1: Format Validation
// ─────────────────────────────────────────────
function validateFormat(email) {
  const result = { passed: false, details: [] };
  if (!email || typeof email !== 'string') { result.details.push('Email is empty or not a string'); return result; }
  const trimmed = email.trim();
  const basicRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basicRegex.test(trimmed)) { result.details.push('Invalid email format (missing @ or domain)'); return result; }
  const [localPart, domain] = trimmed.split('@');
  if (localPart.length === 0) result.details.push('Local part is empty');
  if (localPart.length > 64) result.details.push('Local part too long (max 64 chars)');
  if (localPart.startsWith('.') || localPart.endsWith('.')) result.details.push('Local part cannot start or end with a dot');
  if (localPart.includes('..')) result.details.push('Local part cannot have consecutive dots');
  if (/[<>,;:\\"\[\]]/.test(localPart)) result.details.push('Local part has invalid special characters');
  if (!domain || domain.length === 0) result.details.push('Domain is empty');
  if (domain && domain.length > 253) result.details.push('Domain too long');
  if (domain && !domain.includes('.')) result.details.push('Domain has no TLD');
  if (domain && domain.startsWith('-')) result.details.push('Domain cannot start with hyphen');
  if (domain && domain.endsWith('.')) result.details.push('Domain cannot end with dot');
  if (trimmed.length > 320) result.details.push('Total email length exceeds 320 characters');
  result.passed = result.details.length === 0;
  if (result.passed) result.details.push('Format is valid');
  return result;
}

// ─────────────────────────────────────────────
// LEVEL 1.5: Disposable Email — STRICT MULTI-SOURCE
// ANY single source flagging = DISPOSABLE (strict mode for student data)
// Sources: Abstract API + Kickbox + Debounce + 3 GitHub blocklists
// ─────────────────────────────────────────────
const disposableCache = new Map();

// Pre-load multiple blocklists at startup
let githubBlocklist = new Set();
let blocklistReady = false;

async function loadBlocklists() {
  const sources = [
    {
      url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf',
      parse: (text) => text.split('\n').map(d => d.trim().toLowerCase()).filter(Boolean)
    },
    {
      url: 'https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/index.json',
      parse: (text) => JSON.parse(text)
    },
    {
      url: 'https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt',
      parse: (text) => text.split('\n').map(d => d.trim().toLowerCase()).filter(Boolean)
    }
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const text = await res.text();
        const domains = src.parse(text);
        domains.forEach(d => githubBlocklist.add(d));
      }
    } catch (_) {}
  }
  blocklistReady = true;
  console.log(`📋 Disposable blocklist ready: ${githubBlocklist.size} domains loaded`);
}

loadBlocklists(); // run at startup

async function checkDisposable(email) {
  const result = { isDisposable: false, source: null, details: [], checkedSources: [] };
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return result;

  if (disposableCache.has(domain)) {
    const cached = disposableCache.get(domain);
    return { ...cached, details: [`[cached] ${cached.details[0] || ''}`] };
  }

  const flaggedBy = [];
  const checkedSources = [];

  // ── Source 1: Abstract API (weighted highest) ──
  const ABSTRACT_API_KEY = process.env.ABSTRACT_API_KEY;
  if (ABSTRACT_API_KEY) {
    try {
      const url = `https://emailvalidation.abstractapi.com/v1/?api_key=${ABSTRACT_API_KEY}&email=${encodeURIComponent(email)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.is_disposable_email?.value === true) flaggedBy.push('Abstract API');
        checkedSources.push(`Abstract API: ${data.is_disposable_email?.value ? '🚫' : '✓'}`);
      }
    } catch (_) { checkedSources.push('Abstract API: unavailable'); }
  }

  // ── Source 2: Kickbox open API ──
  try {
    const res = await fetch(`https://open.kickbox.com/v1/disposable/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data.disposable === true) flaggedBy.push('Kickbox');
      checkedSources.push(`Kickbox: ${data.disposable ? '🚫' : '✓'}`);
    }
  } catch (_) { checkedSources.push('Kickbox: unavailable'); }

  // ── Source 3: Debounce disposable API ──
  try {
    const res = await fetch(`https://disposable.debounce.io/?email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data.disposable === 'true' || data.disposable === true) flaggedBy.push('Debounce');
      checkedSources.push(`Debounce: ${(data.disposable === 'true' || data.disposable === true) ? '🚫' : '✓'}`);
    }
  } catch (_) { checkedSources.push('Debounce: unavailable'); }

  // ── Source 4: Pre-loaded GitHub blocklists (instant) ──
  if (blocklistReady && githubBlocklist.size > 0) {
    if (githubBlocklist.has(domain)) flaggedBy.push('Community blocklist');
    checkedSources.push(`Blocklist (${githubBlocklist.size} domains): ${githubBlocklist.has(domain) ? '🚫' : '✓'}`);
  }

  // ── STRICT MODE: ANY source flagging = disposable ──
  result.isDisposable = flaggedBy.length > 0;
  result.checkedSources = checkedSources;
  result.flaggedBy = flaggedBy;
  result.source = flaggedBy.length > 0 ? flaggedBy.join(' + ') : checkedSources.filter(s => !s.includes('unavailable')).length + ' sources';

  if (result.isDisposable) {
    result.details.push(`🚫 Disposable/temp email detected — flagged by: ${flaggedBy.join(', ')}`);
    checkedSources.forEach(s => result.details.push(`  ${s}`));
  } else {
    const checked = checkedSources.filter(s => !s.includes('unavailable')).length;
    result.details.push(`✓ Not disposable (verified across ${checked} source${checked !== 1 ? 's' : ''})`);
    checkedSources.forEach(s => result.details.push(`  ${s}`));
  }

  disposableCache.set(domain, result);
  return result;
}

// ─────────────────────────────────────────────
// LEVEL 2: MX Record / DNS Validation
// ─────────────────────────────────────────────
async function validateMX(email) {
  const result = { passed: false, details: [], mxRecords: [] };
  try {
    const domain = email.split('@')[1];
    if (!domain) { result.details.push('No domain found'); return result; }
    let mxRecords = [];
    try {
      mxRecords = await resolveMx(domain);
    } catch (_) {
      try {
        const resolve4 = promisify(dns.resolve4);
        const aRecords = await resolve4(domain);
        if (aRecords?.length > 0) {
          result.passed = true;
          result.details.push(`No MX record, but A record exists: ${aRecords[0]}`);
          result.mxRecords = [{ exchange: domain, priority: 0, note: 'A record fallback' }];
          return result;
        }
      } catch { result.details.push('Domain does not exist or has no DNS records'); return result; }
    }
    if (!mxRecords?.length) { result.details.push('Domain has no MX records — cannot receive email'); return result; }
    mxRecords.sort((a, b) => a.priority - b.priority);
    result.mxRecords = mxRecords.map(r => ({ exchange: r.exchange, priority: r.priority }));
    result.passed = true;
    result.details.push(`Found ${mxRecords.length} MX record(s). Primary: ${mxRecords[0].exchange} (priority: ${mxRecords[0].priority})`);
  } catch (err) { result.details.push(`DNS lookup failed: ${err.message}`); }
  return result;
}

// ─────────────────────────────────────────────
// LEVEL 3: SMTP Validation
// ─────────────────────────────────────────────
function smtpCheck(mxHost, email) {
  return new Promise((resolve) => {
    const result = { passed: null, details: [], smtpResponse: [] };
    let resolved = false;
    const done = (r) => { if (!resolved) { resolved = true; socket.destroy(); resolve(r); } };
    const socket = new net.Socket();
    const domain = email.split('@')[1];
    socket.setTimeout(8000);
    socket.connect(25, mxHost);
    let step = 0, buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        result.smtpResponse.push(line);
        if (step === 0 && line.startsWith('220')) { socket.write(`EHLO validator.check\r\n`); step = 1; }
        else if (step === 1 && line.startsWith('250') && !line.startsWith('250-')) { socket.write(`MAIL FROM:<verify@${domain}>\r\n`); step = 2; }
        else if (step === 2 && line.startsWith('250')) { socket.write(`RCPT TO:<${email}>\r\n`); step = 3; }
        else if (step === 3) {
          if (line.startsWith('250') || line.startsWith('251')) { result.passed = true; result.details.push(`SMTP confirmed mailbox exists (${line.slice(0, 50)})`); }
          else if (line.startsWith('550') || line.startsWith('551') || line.startsWith('553')) { result.passed = false; result.details.push(`Mailbox does not exist (${line.slice(0, 50)})`); }
          else if (line.startsWith('45')) { result.passed = true; result.details.push(`Mailbox temporarily unavailable — likely exists`); }
          else { result.passed = null; result.details.push(`Server blocked SMTP verification (anti-spam)`); }
          socket.write(`QUIT\r\n`); done(result);
        }
      }
    });
    socket.on('timeout', () => { result.passed = null; result.details.push('SMTP timed out (port 25 likely blocked by hosting)'); done(result); });
    socket.on('error', (err) => { result.passed = null; result.details.push(err.code === 'ECONNREFUSED' ? 'SMTP port 25 refused' : `SMTP error: ${err.message}`); done(result); });
    socket.on('close', () => { if (!resolved) { result.passed = null; result.details.push('Connection closed'); done(result); } });
  });
}

// ─────────────────────────────────────────────
// MAIN: POST /api/validate
// ─────────────────────────────────────────────
app.post('/api/validate', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const startTime = Date.now();
  const e = email.trim().toLowerCase();

  // Step 1: Format
  const fmt = validateFormat(e);
  if (!fmt.passed) {
    return res.json({
      email: e, overallStatus: 'INVALID', confidence: 0, timeTaken: Date.now() - startTime,
      checks: { format: { passed: false, details: fmt.details }, disposable: { passed: null, details: ['Skipped'] }, mx: { passed: null, details: ['Skipped'] }, smtp: { passed: null, details: ['Skipped'] } },
      summary: '❌ Invalid email format'
    });
  }

  // Step 1.5 + 2 in parallel
  const [disp, mx] = await Promise.all([checkDisposable(e), validateMX(e)]);

  // Disposable — hard block
  if (disp.isDisposable) {
    return res.json({
      email: e, overallStatus: 'DISPOSABLE', confidence: 0, timeTaken: Date.now() - startTime,
      checks: {
        format: { passed: true, details: fmt.details },
        disposable: { passed: false, details: disp.details, source: disp.source, flaggedBy: disp.flaggedBy },
        mx: { passed: mx.passed, details: mx.details, mxRecords: mx.mxRecords || [] },
        smtp: { passed: null, details: ['Skipped — disposable email blocked'] }
      },
      summary: `🚫 Disposable/temp email — blocked (flagged by: ${disp.source})`
    });
  }

  // MX fail
  if (!mx.passed) {
    return res.json({
      email: e, overallStatus: 'INVALID', confidence: 15, timeTaken: Date.now() - startTime,
      checks: {
        format: { passed: true, details: fmt.details },
        disposable: { passed: true, details: disp.details },
        mx: { passed: false, details: mx.details, mxRecords: [] },
        smtp: { passed: null, details: ['Skipped — no MX records'] }
      },
      summary: '❌ Domain cannot receive emails'
    });
  }

  // Step 3: SMTP
  let smtp = { passed: null, details: ['Not attempted'], smtpResponse: [] };
  for (const mxr of mx.mxRecords.slice(0, 2)) {
    const r = await smtpCheck(mxr.exchange, e);
    smtp = r;
    if (r.passed !== null) break;
  }

  let confidence = 20 + 10 + 30;
  let overallStatus;
  if (smtp.passed === true) { confidence += 40; overallStatus = 'VALID'; }
  else if (smtp.passed === false) { confidence = 10; overallStatus = 'INVALID'; }
  else { confidence += 20; overallStatus = confidence >= 70 ? 'LIKELY_VALID' : 'UNKNOWN'; }

  const summaryMap = {
    VALID: '✅ Valid — mailbox confirmed',
    INVALID: '❌ Mailbox does not exist',
    LIKELY_VALID: '⚠️ Likely valid (SMTP blocked by provider)',
    UNKNOWN: '⚠️ Uncertain — could not fully verify'
  };

  return res.json({
    email: e, overallStatus, confidence, timeTaken: Date.now() - startTime,
    checks: {
      format: { passed: true, details: fmt.details },
      disposable: { passed: true, details: disp.details, source: disp.source },
      mx: { passed: mx.passed, details: mx.details, mxRecords: mx.mxRecords },
      smtp: { passed: smtp.passed, details: smtp.details, smtpResponse: smtp.smtpResponse }
    },
    summary: summaryMap[overallStatus]
  });
});

// ─────────────────────────────────────────────
// BULK: POST /api/validate/bulk
// ─────────────────────────────────────────────
app.post('/api/validate/bulk', async (req, res) => {
  const { emails } = req.body;
  if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
  if (emails.length > 50) return res.status(400).json({ error: 'Max 50 emails per request' });

  const results = [];
  for (let i = 0; i < emails.length; i += 5) {
    const batch = emails.slice(i, i + 5);
    const br = await Promise.all(batch.map(async (email) => {
      const e = email.trim().toLowerCase();
      const fmt = validateFormat(e);
      if (!fmt.passed) return { email: e, overallStatus: 'INVALID', confidence: 0, summary: '❌ Format invalid' };
      const [disp, mx] = await Promise.all([checkDisposable(e), validateMX(e)]);
      if (disp.isDisposable) return { email: e, overallStatus: 'DISPOSABLE', confidence: 0, summary: `🚫 Disposable (${disp.source})` };
      if (!mx.passed) return { email: e, overallStatus: 'INVALID', confidence: 15, summary: '❌ No MX records' };
      const smtp = await smtpCheck(mx.mxRecords[0]?.exchange, e);
      const c = smtp.passed === true ? 100 : smtp.passed === false ? 10 : 80;
      const s = smtp.passed === true ? 'VALID' : smtp.passed === false ? 'INVALID' : 'LIKELY_VALID';
      const sm = { VALID: '✅ Valid', INVALID: '❌ Invalid', LIKELY_VALID: '⚠️ Likely valid (SMTP blocked)' };
      return { email: e, overallStatus: s, confidence: c, summary: sm[s] };
    }));
    results.push(...br);
  }

  res.json({
    results, total: results.length,
    valid: results.filter(r => r.overallStatus === 'VALID').length,
    invalid: results.filter(r => r.overallStatus === 'INVALID').length,
    disposable: results.filter(r => r.overallStatus === 'DISPOSABLE').length,
    unknown: results.filter(r => ['LIKELY_VALID', 'UNKNOWN'].includes(r.overallStatus)).length
  });
});

app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  abstractApiConfigured: !!process.env.ABSTRACT_API_KEY,
  blocklistReady,
  blocklistSize: githubBlocklist.size
}));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Abstract API: ${process.env.ABSTRACT_API_KEY ? 'Configured ✓' : 'Not set (Kickbox + blocklist fallback)'}`);
});
