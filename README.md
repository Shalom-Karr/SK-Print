# SK Print

PIN-gated file drop for printing. Upload PDFs and images from anywhere, view or
download them from the machine attached to the printer, then clear them out.

**Live:** https://skprint.pages.dev

Cloudflare Pages + Functions. No build step, no framework — vanilla JS and
Tailwind from CDN.

## How it works

| Concern | Where it lives | Binding |
| :--- | :--- | :--- |
| File bytes | KV | `FILES` |
| File metadata rows | D1 | `DB` |
| Current PIN | KV | `SETTINGS` |
| Bootstrap PIN | env var | `LOGIN_PIN` |
| Session signing key | env var | `SESSION_SECRET` |

**Why the PIN is in KV rather than only in the env var.** Cloudflare environment
variables are immutable at runtime — a Function cannot rewrite one. Since the PIN
has to be resettable from the UI, `LOGIN_PIN` seeds KV on first use and every
reset writes to KV thereafter. The env var is the bootstrap value, not the
source of truth.

**Why metadata is in D1 and not KV.** Listing files from KV means a prefix scan
plus a read per key. One indexed D1 query returns the whole list, and the
`SUM(size)` for the storage total comes free.

**Sessions** are HMAC-SHA256 signed cookies (`HttpOnly`, `Secure`,
`SameSite=Strict`, 7 days). Nothing is stored server-side, so there is no session
table to expire. Rotating `SESSION_SECRET` invalidates every session at once.

## Limits

**25 MB per file**, enforced server-side. That is KV's hard per-value ceiling,
not an arbitrary number. Accepted types: PDF, PNG, JPEG, WebP, GIF, HEIC, TIFF.
Anything else is rejected per-file with a reason, so one bad file in a batch
does not fail the rest.

KV's free tier allows 1 GB of storage and 1,000 writes per day. Each uploaded
file is one write. The **Delete all** button in the View tab exists so this stays
comfortably inside those limits — clear the files once they are printed.

### Upgrading to R2

If you outgrow KV — files over 25 MB, or more than ~1,000 uploads a day — R2 is
the correct home for the blobs. Enable R2 in the dashboard, create a bucket,
change the `FILES` binding to an R2 bucket, and adjust three call sites in
`functions/api/[[route]].js`:

```js
env.FILES.put(id, await file.arrayBuffer(), { metadata: {...} })
  → env.FILES.put(id, file.stream(), { httpMetadata: { contentType: file.type } })

await env.FILES.get(id, { type: 'stream' })
  → (await env.FILES.get(id)).body

ids.map(k => env.FILES.delete(k))     // one at a time
  → env.FILES.delete(ids.slice(i, i + 1000))   // R2 takes arrays
```

Nothing else changes — D1 keeps the metadata either way, and the object key is
the same uuid as the row id.

## Setup

Resources already exist on the `Shalomkarr@gmail.com` account:

| Resource | Name | ID |
| :--- | :--- | :--- |
| D1 | `skprint` | `2425a918-6f58-421c-96b1-45079b6610d1` |
| KV | `skprint-files` | `889a2d4256ba4a2b92591f238bb6908a` |
| KV | `skprint-settings` | `c2341f06166f4cf2a69ec4d9ab8d8f25` |

Set both of these as **encrypted** environment variables in the Pages project:

| Variable | Value |
| :--- | :--- |
| `LOGIN_PIN` | initial PIN, 4–12 digits |
| `SESSION_SECRET` | long random string |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To recreate from scratch:

```bash
npx wrangler d1 create skprint
npx wrangler d1 execute skprint --remote --file=./schema.sql
npx wrangler kv namespace create skprint-files
npx wrangler kv namespace create skprint-settings
```

## API

All routes under `/api/`. Everything except `login`, `logout` and `session`
requires a valid session cookie.

| Method | Route | Purpose |
| :--- | :--- | :--- |
| `POST` | `login` | `{pin}` → sets session cookie |
| `POST` | `logout` | clears the cookie |
| `GET` | `session` | `{authed: bool}` |
| `POST` | `pin` | `{current, next}` → changes the PIN |
| `GET` | `files` | metadata for the 500 most recent, plus totals |
| `POST` | `upload` | multipart, field name `files`, repeatable |
| `GET` | `file/:id` | streams the file; `?download` forces save |
| `DELETE` | `file/:id` | removes one file |
| `DELETE` | `files` | removes everything |

## Security notes

- PIN comparison is timing-safe, and a failed login carries a fixed 400 ms delay
  so a wrong PIN is not detectable from response time.
- The MIME allowlist is enforced server-side; the `accept` attribute on the
  input is a convenience, not a control.
- **There is no per-IP rate limiting.** A 4-digit PIN is brute-forceable. Add a
  Cloudflare WAF rate-limiting rule on `/api/login` before exposing this
  publicly — that belongs at the edge, not in application code.
- A single shared PIN means no per-user attribution. That is the intended design
  for a household or office printer, not a multi-tenant system.
