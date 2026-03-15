import React, { useState, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5000';

const StatusBadge = ({ status }) => {
  const config = {
    VALID: { color: '#00d084', bg: '#00d08415', label: 'VALID', icon: '✓' },
    INVALID: { color: '#ff4757', bg: '#ff475715', label: 'INVALID', icon: '✗' },
    DISPOSABLE: { color: '#ff6b35', bg: '#ff6b3515', label: 'DISPOSABLE', icon: '🚫' },
    LIKELY_VALID: { color: '#ffa502', bg: '#ffa50215', label: 'LIKELY VALID', icon: '~' },
    UNKNOWN: { color: '#a0a0b0', bg: '#a0a0b015', label: 'UNKNOWN', icon: '?' },
  };
  const c = config[status] || config.UNKNOWN;
  return (
    <span className="status-badge" style={{ color: c.color, background: c.bg, border: `1px solid ${c.color}40` }}>
      <span className="status-icon">{c.icon}</span> {c.label}
    </span>
  );
};

const ConfidenceMeter = ({ score }) => {
  const color = score >= 80 ? '#00d084' : score >= 50 ? '#ffa502' : '#ff4757';
  return (
    <div className="confidence-meter">
      <div className="confidence-label">
        <span>Confidence Score</span>
        <span style={{ color, fontWeight: 700 }}>{score}%</span>
      </div>
      <div className="confidence-track">
        <div className="confidence-fill" style={{ width: `${score}%`, background: color }} />
      </div>
    </div>
  );
};

const CheckRow = ({ label, passed, details, children }) => (
  <div className={`check-row ${passed === true ? 'pass' : passed === false ? 'fail' : 'neutral'}`}>
    <div className="check-header">
      <span className="check-indicator">{passed === true ? '✓' : passed === false ? '✗' : '—'}</span>
      <span className="check-label">{label}</span>
    </div>
    <div className="check-details">
      {details && details.map((d, i) => <div key={i} className="check-detail-item">{d}</div>)}
      {children}
    </div>
  </div>
);

export default function App() {
  const [tab, setTab] = useState('single');
  const [email, setEmail] = useState('');
  const [bulkEmails, setBulkEmails] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const [error, setError] = useState('');

  const validateSingle = useCallback(async () => {
    if (!email.trim()) return;
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const res = await axios.post(`${API_BASE}/api/validate`, { email: email.trim() });
      setResult(res.data);
    } catch (err) {
      setError('Server error — make sure backend is running on port 5000');
    } finally {
      setLoading(false);
    }
  }, [email]);

  const validateBulk = useCallback(async () => {
    const emails = bulkEmails.split('\n').map(e => e.trim()).filter(Boolean);
    if (!emails.length) return;
    if (emails.length > 50) { setError('Max 50 emails at once'); return; }
    setLoading(true);
    setBulkResult(null);
    setError('');
    try {
      const res = await axios.post(`${API_BASE}/api/validate/bulk`, { emails });
      setBulkResult(res.data);
    } catch (err) {
      setError('Server error — make sure backend is running on port 5000');
    } finally {
      setLoading(false);
    }
  }, [bulkEmails]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') validateSingle();
  };

  return (
    <div className="app">
      <div className="app-bg" />

      <header className="header">
        <div className="header-icon">@</div>
        <div>
          <h1 className="header-title">Email Validator Pro</h1>
          <p className="header-sub">4-Layer Deep Validation — Format · Disposable · MX · SMTP</p>
        </div>
      </header>

      <div className="tabs">
        <button className={`tab ${tab === 'single' ? 'active' : ''}`} onClick={() => setTab('single')}>
          Single Email
        </button>
        <button className={`tab ${tab === 'bulk' ? 'active' : ''}`} onClick={() => setTab('bulk')}>
          Bulk Validate
        </button>
      </div>

      <div className="card">
        {tab === 'single' ? (
          <>
            <div className="input-row">
              <input
                className="email-input"
                type="text"
                placeholder="Enter email address to verify..."
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
              />
              <button className="validate-btn" onClick={validateSingle} disabled={loading || !email.trim()}>
                {loading ? <span className="spinner" /> : 'Verify'}
              </button>
            </div>

            {error && <div className="error-msg">{error}</div>}

            {loading && (
              <div className="loading-state">
                <div className="loading-steps">
                  <div className="loading-step active">① Checking format...</div>
                  <div className="loading-step">② Looking up MX records...</div>
                  <div className="loading-step">③ SMTP handshake...</div>
                </div>
              </div>
            )}

            {result && (
              <div className="result">
                <div className="result-header">
                  <div>
                    <div className="result-email">{result.email}</div>
                    <div className="result-time">{result.timeTaken}ms</div>
                  </div>
                  <StatusBadge status={result.overallStatus} />
                </div>

                <div className="result-summary">{result.summary}</div>
                <ConfidenceMeter score={result.confidence} />

                <div className="checks">
                  <CheckRow
                    label="① Format Validation"
                    passed={result.checks.format.passed}
                    details={result.checks.format.details}
                  />
                  <CheckRow
                    label="② Disposable / Temp Email Check"
                    passed={result.checks.disposable?.passed}
                    details={result.checks.disposable?.details}
                  >
                    {result.checks.disposable?.source && (
                      <div className="check-detail-item">Source: {result.checks.disposable.source}</div>
                    )}
                  </CheckRow>
                  <CheckRow
                    label="③ MX Record / DNS Check"
                    passed={result.checks.mx.passed}
                    details={result.checks.mx.details}
                  >
                    {result.checks.mx.mxRecords?.length > 0 && (
                      <div className="mx-records">
                        {result.checks.mx.mxRecords.map((mx, i) => (
                          <div key={i} className="mx-record">
                            <span className="mx-priority">P{mx.priority}</span>
                            <span>{mx.exchange}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CheckRow>
                  <CheckRow
                    label="④ SMTP Mailbox Check"
                    passed={result.checks.smtp.passed}
                    details={result.checks.smtp.details}
                  >
                    {result.checks.smtp.smtpResponse?.length > 0 && (
                      <details className="smtp-log">
                        <summary>View SMTP Log</summary>
                        <div className="smtp-log-content">
                          {result.checks.smtp.smtpResponse.map((line, i) => (
                            <div key={i} className="smtp-line">{line}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </CheckRow>
                </div>

                <div className="accuracy-note">
                  <span className="note-icon">ℹ</span>
                  <span>Note: Some servers (Gmail, Yahoo) block SMTP probing as anti-spam. In those cases, confidence is based on Format + MX which is ~80% accurate. True 100% verification requires sending an actual email.</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <textarea
              className="bulk-input"
              placeholder={"Enter emails — one per line:\njohn@example.com\nstudent1@college.edu\ntest@domain.com"}
              value={bulkEmails}
              onChange={e => setBulkEmails(e.target.value)}
              disabled={loading}
              rows={8}
            />
            <div className="bulk-footer">
              <span className="email-count">
                {bulkEmails.split('\n').filter(e => e.trim()).length} emails
              </span>
              <button className="validate-btn" onClick={validateBulk} disabled={loading || !bulkEmails.trim()}>
                {loading ? <span className="spinner" /> : 'Validate All'}
              </button>
            </div>

            {error && <div className="error-msg">{error}</div>}

            {bulkResult && (
              <div className="bulk-result">
                <div className="bulk-stats">
                  <div className="stat valid">
                    <div className="stat-num">{bulkResult.valid}</div>
                    <div className="stat-label">Valid</div>
                  </div>
                  <div className="stat invalid">
                    <div className="stat-num">{bulkResult.invalid}</div>
                    <div className="stat-label">Invalid</div>
                  </div>
                  <div className="stat unknown">
                    <div className="stat-num">{bulkResult.unknown}</div>
                    <div className="stat-label">Uncertain</div>
                  </div>
                  <div className="stat total">
                    <div className="stat-num">{bulkResult.total}</div>
                    <div className="stat-label">Total</div>
                  </div>
                </div>

                <div className="bulk-table-wrap">
                  <table className="bulk-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Email</th>
                        <th>Status</th>
                        <th>Confidence</th>
                        <th>Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkResult.results.map((r, i) => (
                        <tr key={i} className={r.overallStatus.toLowerCase()}>
                          <td>{i + 1}</td>
                          <td className="email-cell">{r.email}</td>
                          <td><StatusBadge status={r.overallStatus} /></td>
                          <td>
                            <span className="confidence-pill" style={{
                              color: r.confidence >= 80 ? '#00d084' : r.confidence >= 50 ? '#ffa502' : '#ff4757'
                            }}>{r.confidence}%</span>
                          </td>
                          <td className="summary-cell">{r.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button className="export-btn" onClick={() => {
                  const csv = ['Email,Status,Confidence,Summary', ...bulkResult.results.map(r => `${r.email},${r.overallStatus},${r.confidence}%,"${r.summary}"`)].join('\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = 'email_validation_results.csv'; a.click();
                }}>
                  ↓ Export CSV
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="legend">
        <div className="legend-title">How it works</div>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-num">1</span>
            <div><strong>Format Check</strong> — Validates structure, length, special chars, disposable domains</div>
          </div>
          <div className="legend-item">
            <span className="legend-num">2</span>
            <div><strong>MX Record Check</strong> — Confirms domain can actually receive emails via DNS</div>
          </div>
          <div className="legend-item">
            <span className="legend-num">3</span>
            <div><strong>SMTP Check</strong> — Contacts mail server directly to verify mailbox existence</div>
          </div>
        </div>
      </div>
    </div>
  );
}
