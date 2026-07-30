# SK Print

PIN-gated file drop for printing. Upload PDFs and images from anywhere, view or
download them from the machine attached to the printer.

Cloudflare Pages + Functions. No build step, no framework — vanilla JS and
Tailwind from CDN.

## How it works

| Concern | Where it lives |
| :--- | :--- |
| File bytes | **R2** (`FILES` binding) |
| File metadata rows | **D1** (`DB` binding) |
| Current PIN | **KV** (`SETTINGS` binding) |
| Bootstrap PIN | `LOGIN_PIN` env var |
| Session signing key | `SESSION_SECRET` env var |

**Why R2 and not KV or D1 for the files.** KV caps values at 25 MiB and is a
key-value cache, not blob storage; D1 is SQLite and storing binaries in it wastes
the query engine and hits row limits. R2 is Cloudflare's object store and is what
this is for. Metadata still goes in D1 so listing is a single indexed query.

**Why the PIN is in KV rather than only in the env var.** Cloudflare environment
variables are immutable at runtime — a Function cannot rewrite one. Since the PIN
has to be resettable from the UI, `LOGIN_PIN` seeds KV on first use and every
reset writes to KV thereafter. The env var is the bootstrap value, not the
source of truth.

**Sessions** are HMAC-SHA256 signed cookies (`HttpOnly`, `Secure`,
`SameSite=Strict`, 7 days). Nothing is stored server-side, so there is no session
table to expire.

## Setup

```bash
# 1. R2 bucket for the files
npx wrangler r2 bucket create sk-print

# 2. D1 database for the metadata
npx wrangler d1 create sk-print
npx wrangler d1 execute sk-print --remote --file=./schema.sql

# 3. KV namespace for the PIN
npx wrangler kv namespace create SETTINGS
```

Then in the Cloudflare dashboard → your Pages project → **Settings → Bindings**:

| Binding name | Type | Value |
| :--- | :--- | :--- |
| `FILES` | R2 bucket | `sk-print` |
| `DB` | D1 database | `sk-print` |
| `SETTINGS` | KV namespace | the id from step 3 |

And under **Settings → Environment variables** (both set as **encrypted**):

| Variable | Value |
| :--- | :--- |
| `LOGIN_PIN` | your initial PIN, 4–12 digits |
| `SESSION_SECRET` | a long random string |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating `SESSION_SECRET` invalidates every existing session, which is the
fastest way to force everyone to log in again.

## API

All routes are under `/api/`. Everything except `login`, `logout` and `session`
requires a valid session cookie.

| Method | Route | Purpose |
| :--- | :--- | :--- |
| `POST` | `login` | `{pin}` → sets session cookie |
| `POST` | `logout` | clears the cookie |
| `GET` | `session` | `{authed: bool}` |
| `POST` | `pin` | `{current, next}` → changes the PIN |
| `GET` | `files` | metadata for the 500 most recent |
| `POST` | `upload` | multipart, field name `files`, repeatable |
| `GET` | `file/:id` | streams the file; `?download` forces save |
| `DELETE` | `file/:id` | removes from R2 and D1 |

## Limits

25 MB per file, enforced server-side. Accepted types: PDF, PNG, JPEG, WebP, GIF,
HEIC, TIFF. Anything else is rejected per-file with a reason, so one bad file in
a batch does not fail the rest.

## Security notes

- PIN comparison is timing-safe, and a failed login carries a fixed 400 ms delay
  so a wrong PIN is not detectable from response time.
- The MIME allowlist is checked server-side; the `accept` attribute on the input
  is a convenience, not a control.
- There is no per-IP rate limiting. If this is exposed publicly, add a
  Cloudflare WAF rate-limiting rule on `/api/login` — that belongs at the edge,
  not in application code.
- A single shared PIN means no per-user attribution. That is the intended design
  for a household or office printer, not a multi-tenant system.
