import express from 'express';
import cors from 'cors';
import dns from 'dns';
import net from 'net';
import { promisify } from 'util';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const resolveMx = promisify(dns.resolveMx);
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://email-validator-pro-sigma.vercel.app',
    /.vercel.app$/
  ]
}));
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
// LEVEL 2: ZeroBounce — Primary Validator
// Handles Gmail, Yahoo, Outlook etc.
// Returns: valid, invalid, catch-all, unknown, disposable, spamtrap, abuse, do_not_mail
// ─────────────────────────────────────────────
const zbCache = new Map();

async function checkZeroBounce(email) {
  const result = {
    status: null,       // valid | invalid | catch-all | unknown | disposable | spamtrap | abuse | do_not_mail
    subStatus: null,
    isDisposable: false,
    isFreeEmail: false,
    confidence: 0,
    details: [],
    raw: null
  };

  const ZEROBOUNCE_KEY = process.env.ZEROBOUNCE_API_KEY;
  if (!ZEROBOUNCE_KEY) {
    result.details.push('ZeroBounce API key not configured');
    return result;
  }

  const cacheKey = email.toLowerCase();
  if (zbCache.has(cacheKey)) {
    return zbCache.get(cacheKey);
  }

  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${ZEROBOUNCE_KEY}&email=${encodeURIComponent(email)}&ip_address=`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      result.details.push(`ZeroBounce API error: ${res.status}`);
      return result;
    }

    const data = await res.json();
    result.raw = data;
    result.status = data.status;
    result.subStatus = data.sub_status;
    result.isDisposable = data.status === 'disposable' || data.sub_status === 'disposable';
    result.isFreeEmail = data.free_email === true;

    // Map ZeroBounce status to confidence
    switch (data.status) {
      case 'valid':
        result.confidence = 99;
        result.details.push(`✅ ZeroBounce confirmed: VALID mailbox exists`);
        if (data.sub_status) result.details.push(`  Sub-status: ${data.sub_status}`);
        if (data.free_email) result.details.push(`  Free email provider (Gmail/Yahoo/etc)`);
        break;
      case 'invalid':
        result.confidence = 0;
        result.details.push(`❌ ZeroBounce confirmed: INVALID — mailbox does not exist`);
        if (data.sub_status) result.details.push(`  Reason: ${data.sub_status.replace(/_/g, ' ')}`);
        break;
      case 'catch-all':
        result.confidence = 60;
        result.details.push(`⚠️ Catch-all domain — server accepts all emails (cannot verify individual mailbox)`);
        break;
      case 'unknown':
        result.confidence = 50;
        result.details.push(`⚠️ Unknown — server did not respond to verification`);
        if (data.sub_status) result.details.push(`  Reason: ${data.sub_status.replace(/_/g, ' ')}`);
        break;
      case 'disposable':
        result.confidence = 0;
        result.isDisposable = true;
        result.details.push(`🚫 Disposable/temporary email detected`);
        break;
      case 'spamtrap':
        result.confidence = 0;
        result.details.push(`🚫 Spam trap email — do not use`);
        break;
      case 'abuse':
        result.confidence = 0;
        result.details.push(`🚫 Known abuser/complaint email`);
        break;
      case 'do_not_mail':
        result.confidence = 0;
        result.details.push(`🚫 Do not mail — ${data.sub_status || 'flagged address'}`);
        break;
      default:
        result.confidence = 40;
        result.details.push(`ZeroBounce status: ${data.status}`);
    }

    if (data.firstname || data.lastname) {
      result.details.push(`  Name on file: ${[data.firstname, data.lastname].filter(Boolean).join(' ')}`);
    }

  } catch (err) {
    result.details.push(`ZeroBounce error: ${err.message}`);
  }

  zbCache.set(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// LEVEL 1.5: Disposable Email Check (backup)
// Used if ZeroBounce key not set
// ─────────────────────────────────────────────
const disposableCache = new Map();
let githubBlocklist = new Set();
let blocklistReady = false;

async function loadBlocklists() {
  const sources = [
    { url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf', parse: (t) => t.split('\n').map(d => d.trim().toLowerCase()).filter(Boolean) },
    { url: 'https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/index.json', parse: (t) => JSON.parse(t) },
    { url: 'https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt', parse: (t) => t.split('\n').map(d => d.trim().toLowerCase()).filter(Boolean) }
  ];
  for (const src of sources) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) { const domains = src.parse(await res.text()); domains.forEach(d => githubBlocklist.add(d)); }
    } catch (_) {}
  }
  blocklistReady = true;
  console.log(`📋 Blocklist ready: ${githubBlocklist.size} domains`);
}
loadBlocklists();

async function checkDisposable(email) {
  const result = { isDisposable: false, source: null, details: [], checkedSources: [] };
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return result;
  if (disposableCache.has(domain)) return disposableCache.get(domain);

  const flaggedBy = [];
  const checkedSources = [];

  try {
    const res = await fetch(`https://open.kickbox.com/v1/disposable/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) { const data = await res.json(); if (data.disposable) flaggedBy.push('Kickbox'); checkedSources.push(`Kickbox: ${data.disposable ? '🚫' : '✓'}`); }
  } catch (_) { checkedSources.push('Kickbox: unavailable'); }

  try {
    const res = await fetch(`https://disposable.debounce.io/?email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) { const data = await res.json(); const d = data.disposable === 'true' || data.disposable === true; if (d) flaggedBy.push('Debounce'); checkedSources.push(`Debounce: ${d ? '🚫' : '✓'}`); }
  } catch (_) { checkedSources.push('Debounce: unavailable'); }

  if (blocklistReady && githubBlocklist.size > 0) {
    if (githubBlocklist.has(domain)) flaggedBy.push('Blocklist');
    checkedSources.push(`Blocklist (${githubBlocklist.size}): ${githubBlocklist.has(domain) ? '🚫' : '✓'}`);
  }

  result.isDisposable = flaggedBy.length > 0;
  result.source = flaggedBy.length > 0 ? flaggedBy.join(' + ') : `${checkedSources.filter(s => !s.includes('unavailable')).length} sources`;
  result.details.push(result.isDisposable ? `🚫 Disposable detected (${flaggedBy.join(', ')})` : `✓ Not disposable (${checkedSources.filter(s => !s.includes('unavailable')).length} sources checked)`);
  checkedSources.forEach(s => result.details.push(`  ${s}`));
  result.checkedSources = checkedSources;

  disposableCache.set(domain, result);
  return result;
}

// ─────────────────────────────────────────────
// LEVEL 3: MX Record Check (backup/extra)
// ─────────────────────────────────────────────
async function validateMX(email) {
  const result = { passed: false, details: [], mxRecords: [] };
  try {
    const domain = email.split('@')[1];
    if (!domain) { result.details.push('No domain found'); return result; }
    let mxRecords = [];
    try { mxRecords = await resolveMx(domain); } catch (_) {
      try {
        const resolve4 = promisify(dns.resolve4);
        const aRecords = await resolve4(domain);
        if (aRecords?.length > 0) { result.passed = true; result.details.push(`A record: ${aRecords[0]}`); result.mxRecords = [{ exchange: domain, priority: 0 }]; return result; }
      } catch { result.details.push('Domain does not exist'); return result; }
    }
    if (!mxRecords?.length) { result.details.push('No MX records found'); return result; }
    mxRecords.sort((a, b) => a.priority - b.priority);
    result.mxRecords = mxRecords.map(r => ({ exchange: r.exchange, priority: r.priority }));
    result.passed = true;
    result.details.push(`Found ${mxRecords.length} MX record(s). Primary: ${mxRecords[0].exchange}`);
  } catch (err) { result.details.push(`DNS error: ${err.message}`); }
  return result;
}

// ─────────────────────────────────────────────
// MAIN: POST /api/validate
// ─────────────────────────────────────────────
app.post('/api/validate', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const startTime = Date.now();
  const e = email.trim().toLowerCase();
  const hasZB = !!process.env.ZEROBOUNCE_API_KEY;

  // Step 1: Format
  const fmt = validateFormat(e);
  if (!fmt.passed) {
    return res.json({
      email: e, overallStatus: 'INVALID', confidence: 0, timeTaken: Date.now() - startTime,
      checks: { format: { passed: false, details: fmt.details }, zerobounce: { passed: null, details: ['Skipped'] }, disposable: { passed: null, details: ['Skipped'] }, mx: { passed: null, details: ['Skipped'] } },
      summary: '❌ Invalid email format'
    });
  }

  if (hasZB) {
    // ── ZeroBounce path (full accuracy, Gmail works) ──
    const [zb, mx] = await Promise.all([checkZeroBounce(e), validateMX(e)]);

    const statusMap = {
      'valid': 'VALID',
      'invalid': 'INVALID',
      'disposable': 'DISPOSABLE',
      'spamtrap': 'INVALID',
      'abuse': 'INVALID',
      'do_not_mail': 'INVALID',
      'catch-all': 'LIKELY_VALID',
      'unknown': 'UNKNOWN'
    };

    const overallStatus = statusMap[zb.status] || 'UNKNOWN';
    const summaryMap = {
      VALID: '✅ Valid — ZeroBounce confirmed mailbox exists',
      INVALID: '❌ Invalid — ZeroBounce confirmed mailbox does not exist',
      DISPOSABLE: '🚫 Disposable/temporary email — rejected',
      LIKELY_VALID: '⚠️ Catch-all domain — likely valid but unverifiable',
      UNKNOWN: '⚠️ Unknown — server did not respond'
    };

    return res.json({
      email: e,
      overallStatus,
      confidence: zb.confidence,
      timeTaken: Date.now() - startTime,
      checks: {
        format: { passed: true, details: fmt.details },
        zerobounce: {
          passed: overallStatus === 'VALID',
          status: zb.status,
          subStatus: zb.subStatus,
          isFreeEmail: zb.isFreeEmail,
          details: zb.details
        },
        disposable: { passed: overallStatus !== 'DISPOSABLE', details: [`ZeroBounce disposable check: ${zb.isDisposable ? '🚫 disposable' : '✓ clean'}`] },
        mx: { passed: mx.passed, details: mx.details, mxRecords: mx.mxRecords }
      },
      summary: summaryMap[overallStatus] || summaryMap.UNKNOWN
    });

  } else {
    // ── Fallback path (no ZeroBounce key) ──
    const [disp, mx] = await Promise.all([checkDisposable(e), validateMX(e)]);

    if (disp.isDisposable) {
      return res.json({
        email: e, overallStatus: 'DISPOSABLE', confidence: 0, timeTaken: Date.now() - startTime,
        checks: { format: { passed: true, details: fmt.details }, zerobounce: { passed: null, details: ['ZeroBounce key not configured'] }, disposable: { passed: false, details: disp.details }, mx: { passed: mx.passed, details: mx.details, mxRecords: mx.mxRecords || [] } },
        summary: `🚫 Disposable email detected (${disp.source})`
      });
    }
    if (!mx.passed) {
      return res.json({
        email: e, overallStatus: 'INVALID', confidence: 15, timeTaken: Date.now() - startTime,
        checks: { format: { passed: true, details: fmt.details }, zerobounce: { passed: null, details: ['ZeroBounce key not configured'] }, disposable: { passed: true, details: disp.details }, mx: { passed: false, details: mx.details, mxRecords: [] } },
        summary: '❌ Domain cannot receive emails'
      });
    }
    const confidence = 80;
    return res.json({
      email: e, overallStatus: 'LIKELY_VALID', confidence, timeTaken: Date.now() - startTime,
      checks: { format: { passed: true, details: fmt.details }, zerobounce: { passed: null, details: ['Add ZEROBOUNCE_API_KEY for Gmail/Yahoo verification'] }, disposable: { passed: true, details: disp.details }, mx: { passed: mx.passed, details: mx.details, mxRecords: mx.mxRecords } },
      summary: '⚠️ Likely valid — add ZeroBounce key for Gmail accuracy'
    });
  }
});

// ─────────────────────────────────────────────
// BULK: POST /api/validate/bulk
// ─────────────────────────────────────────────
app.post('/api/validate/bulk', async (req, res) => {
  const { emails } = req.body;
  if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
  if (emails.length > 50) return res.status(400).json({ error: 'Max 50 emails per request' });

  const results = [];
  const hasZB = !!process.env.ZEROBOUNCE_API_KEY;

  for (let i = 0; i < emails.length; i += 5) {
    const batch = emails.slice(i, i + 5);
    const br = await Promise.all(batch.map(async (email) => {
      const e = email.trim().toLowerCase();
      const fmt = validateFormat(e);
      if (!fmt.passed) return { email: e, overallStatus: 'INVALID', confidence: 0, summary: '❌ Format invalid' };

      if (hasZB) {
        const zb = await checkZeroBounce(e);
        const statusMap = { 'valid': 'VALID', 'invalid': 'INVALID', 'disposable': 'DISPOSABLE', 'spamtrap': 'INVALID', 'abuse': 'INVALID', 'do_not_mail': 'INVALID', 'catch-all': 'LIKELY_VALID', 'unknown': 'UNKNOWN' };
        const s = statusMap[zb.status] || 'UNKNOWN';
        const sm = { VALID: '✅ Valid', INVALID: '❌ Invalid', DISPOSABLE: '🚫 Disposable', LIKELY_VALID: '⚠️ Catch-all', UNKNOWN: '⚠️ Unknown' };
        return { email: e, overallStatus: s, confidence: zb.confidence, summary: sm[s], zbStatus: zb.status, zbSubStatus: zb.subStatus };
      } else {
        const [disp, mx] = await Promise.all([checkDisposable(e), validateMX(e)]);
        if (disp.isDisposable) return { email: e, overallStatus: 'DISPOSABLE', confidence: 0, summary: `🚫 Disposable` };
        if (!mx.passed) return { email: e, overallStatus: 'INVALID', confidence: 15, summary: '❌ No MX records' };
        return { email: e, overallStatus: 'LIKELY_VALID', confidence: 80, summary: '⚠️ Likely valid (add ZeroBounce for accuracy)' };
      }
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

// Credits check
app.get('/api/credits', async (_, res) => {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return res.json({ error: 'ZeroBounce key not configured' });
  try {
    const r = await fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${key}`);
    const data = await r.json();
    res.json({ credits: data.Credits });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  zeroBounceConfigured: !!process.env.ZEROBOUNCE_API_KEY,
  blocklistReady,
  blocklistSize: githubBlocklist.size
}));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🎯 ZeroBounce: ${process.env.ZEROBOUNCE_API_KEY ? 'Configured ✓ (Gmail accuracy enabled)' : 'Not set'}`);
});