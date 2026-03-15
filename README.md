# Email Validator Pro — MERN Stack

3-Layer deep email validation tool built with React + Node.js (Express).

## How It Works

| Layer | Check | What it validates |
|-------|-------|-------------------|
| ① Format | Regex + rules | Structure, length, special chars, disposable domains |
| ② MX Records | DNS lookup | Does the domain actually receive emails? |
| ③ SMTP | Live handshake | Does the specific mailbox exist? |

---

## Setup & Run

### Backend (Node.js + Express)

```bash
cd backend
npm install
node server.js
# ✅ Runs on http://localhost:5000
```

### Frontend (React)

```bash
cd frontend
npm install
npm start
# ✅ Opens http://localhost:3000
```

---

## API Endpoints

### POST /api/validate
Validate a single email.

**Request:**
```json
{ "email": "test@example.com" }
```

**Response:**
```json
{
  "email": "test@example.com",
  "overallStatus": "VALID",       // VALID | INVALID | LIKELY_VALID | UNKNOWN
  "confidence": 95,                // 0-100
  "timeTaken": 1240,               // ms
  "checks": {
    "format": { "passed": true, "details": ["Format is valid ✓"] },
    "mx": {
      "passed": true,
      "details": ["Found 2 MX record(s). Primary: mx1.example.com"],
      "mxRecords": [{ "exchange": "mx1.example.com", "priority": 10 }]
    },
    "smtp": {
      "passed": true,
      "details": ["SMTP confirmed mailbox exists (250 OK)"],
      "smtpResponse": ["220 ...", "250 OK", "250 OK", "250 Accepted"]
    }
  },
  "summary": "✅ Email is valid and mailbox exists"
}
```

### POST /api/validate/bulk
Validate up to 50 emails at once.

**Request:**
```json
{ "emails": ["user1@example.com", "user2@test.com"] }
```

**Response:**
```json
{
  "results": [...],
  "total": 2,
  "valid": 1,
  "invalid": 1,
  "unknown": 0
}
```

---

## Status Values

| Status | Meaning |
|--------|---------|
| `VALID` | Confirmed valid — format ✓ MX ✓ SMTP ✓ |
| `INVALID` | Definitely invalid — bad format or non-existent domain/mailbox |
| `LIKELY_VALID` | Format ✓ MX ✓ but SMTP blocked (Gmail, Yahoo anti-spam) |
| `UNKNOWN` | Couldn't fully verify |

---

## Why 100% accuracy isn't possible

Gmail, Yahoo, Microsoft and most large providers **intentionally block SMTP probing** (port 25 or catch-all responses) to prevent spam harvesting. This is an industry-wide limitation.

**Best achievable accuracy:**
- Format only → ~60%
- Format + MX → ~80%  
- Format + MX + SMTP → **~95%** (for domains that allow SMTP checks)

The only way to truly verify 100% is to **send an actual confirmation email**.

---

## Tech Stack

- **Backend:** Node.js, Express, built-in `dns` and `net` modules (no paid APIs needed!)
- **Frontend:** React, Axios, CSS3
- **Zero external API costs** — everything runs locally
