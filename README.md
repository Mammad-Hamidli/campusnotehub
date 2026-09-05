# CampusHub

Verified-student platform for Azerbaijani universities. Three products on one
identity spine:

- **Feed** — academic social timeline (posts, tags, university filters)
- **UniNotes** — peer-to-peer study-note marketplace with an internal wallet
- **PocketMentor** — 1-on-1 mentorship booking with escrowed payments

Trilingual: Azerbaijani (default), English, Russian.

## Run it

```bash
cp .env.example .env
npm install
npx prisma generate

npm run dev            # http://localhost:3000
npm run dev:preview    # same, but /dashboard is reachable without a session
```

`dev:preview` sets `CAMPUSHUB_DEV_BYPASS_AUTH=1`, which lets the middleware
serve `/dashboard` with no login while the auth backend is not running. The
flag is guarded by `NODE_ENV !== 'production'`, which Next inlines and the
minifier strips — the branch does not exist in a production bundle, verified
by grepping `.next/server/middleware.js` after a build.

With a database and Redis:

```bash
docker compose up -d
npm run db:deploy      # migrations
npm run db:invariants  # constraints Prisma cannot express - REQUIRED
npm run db:seed        # 18 universities, tags, platform ledger accounts

npm run worker:scheduler      # review-buffer reaper + graduation safety net
```

`db:invariants` is not optional. It installs the double-entry balance trigger,
the booking-overlap exclusion constraint, the ledger append-only guard, **and
the zero-retention constraints**. Skipping it leaves the retention policy as a
convention rather than an enforced rule.

The graduation sweep runs as a host cron (UTC — 02:00 UTC is 06:00 Baku):

```cron
0 2 1 5 *   cd /app && node dist/server/cron/graduation.js
```

## Known issue: OneDrive and `.next`

This project currently lives inside a OneDrive-synced folder, which breaks
Next.js tooling in two ways.

**The error you will see:**

```
EINVAL: invalid argument, readlink '...\.next\server\edge-runtime-webpack.js'
EINVAL: invalid argument, readlink '...\.next\cache'
```

**Why.** With Files On-Demand enabled, OneDrive replaces files with reparse
points (cloud placeholders). Node's `readlink` on a placeholder returns EINVAL
instead of the "not a symlink" result the caller expects, so the directory walk
throws rather than skipping. OneDrive also syncs `.next` *while* Next.js is
writing to it, so a build can race its own output. The error names a webpack
file, which sends you looking in entirely the wrong place.

**Mitigation in the repo.** `npm run dev` runs `scripts/clean-next.mjs` first.
It removes `.next` only when the directory holds a *production* build (detected
via `BUILD_ID`) - which is the state that breaks dev - and leaves a dev-only
cache alone so warm restarts stay fast. That covers the common
`next build` then `next dev` case.

**The actual fix: move the project out of OneDrive.** Then run `npm install`
again so native modules relink. This also ends the constant `node_modules`
sync churn and makes git noticeably faster.

**What does NOT work**, so nobody spends an afternoon on it: making `.next` a
directory junction to a non-synced location. The build then writes to the real
path outside the project, and Node resolves modules from the *physical* path -
so `.next/server/pages/_document.js` walks up `AppData\Local\...`, never finds
the project's `node_modules`, and fails with
`Cannot find module 'react/jsx-runtime'`. Tested, and reverted.

If you must stay on OneDrive, pausing sync while developing is the reliable
workaround.

## Pages

| Route | What it is |
|---|---|
| `/` | Landing — hero, animated live stats, feature grid, activity ticker |
| `/register` | Three-step signup: account → 4-slot document upload → review |
| `/dashboard` | Sidebar shell, feed with composer and filters, right-rail widgets |
| `/admin/moderation` | Moderator console — the only place a ban can be issued |

Useful query params while developing (they only pick which state to render;
every real permission check happens server-side):

```
/dashboard?verification=UNVERIFIED|PROCESSING|NEEDS_REVIEW|REJECTED|VERIFIED
/dashboard?tab=feed|notes|mentors|wallet
```

## Checks

```bash
npm run typecheck      # 0 errors
npm run check:i18n     # locale parity + every t() key used in src/ resolves
npm run build          # clean, no warnings
npm test
```

`check:i18n` runs two scripts that catch different bugs:

- `check-i18n.mjs` — the three JSON bundles have identical key sets and
  identical ICU placeholders. A placeholder present in `en` but missing in `az`
  throws at render time *in Azerbaijani only*, which is the default locale and
  the one nobody QAs.
- `check-keys-used.mjs` — every `t('...')` and ``t(`...`)`` in `src/` resolves
  against the bundle. This is what stops a raw `landing.hero.badge` rendering
  on a live page.

Both are build gates, not warnings.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System topology, module design, verification policy, deployment |
| [docs/API.md](docs/API.md) | Every endpoint, payloads, rate limits, status codes |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, document lifecycle, data protection, invariants |

## Stack

Next.js 15 (App Router, RSC) · TypeScript · Tailwind · lucide-react ·
PostgreSQL 16 + Prisma · Redis / BullMQ · S3 (notes only) · FastAPI
(document forensics, stateless)

## Layout

```
prisma/     schema, manual SQL invariants, seed
messages/   az.json · en.json · ru.json  (393 keys x 3)
scripts/    i18n CI gates
src/
  app/          page.tsx · register/ · dashboard/ · admin/ · api/
  components/   marketing/ · register/ · dashboard/ · admin/ · mentors/ · ui/
  lib/          i18n/ · crypto/ · storage/ · security/ · verification/
                wallet/ · mentors/ · queue/ · auth/
  server/       cron/ (1 May sweep, buffer reaper), zod validators
services/doc-verifier/   FastAPI image forensics (OpenCV, tesseract)
```

## Localisation

Locale lives in the `CH_LOCALE` cookie, is resolved **server-side** in the root
layout so the first paint is already correct, and switches client-side with no
navigation. All three dictionaries are bundled (~30 KB gzipped) — cheaper than
a round trip plus the layout shift of swapping copy asynchronously.

**Known trade-off:** because the locale is a cookie rather than a URL segment,
`/` serves three languages and search engines will only index one. For public
SEO you want `/az`, `/en`, `/ru` prefixes with hreflang tags, which means
moving the marketing pages under `app/[locale]/`. `/register` and `/dashboard`
are `noindex` anyway and are better served by the instant toggle.

## Security posture in one page

Identity documents are **never stored**. They live in process memory for one
request and are overwritten in a `finally` block. There is no KYC bucket, no
storage key column, and no purge job — because there is nothing to purge.
The database keeps flags (`isVerified`, `verifiedAt`), a confidence number, and
category codes. See [docs/SECURITY.md §3](docs/SECURITY.md#3-zero-retention).

The policy is **enforced by the database**, not by convention.
[`0002_zero_retention.sql`](prisma/migrations/manual/0002_zero_retention.sql)
adds a JSONB type check so score columns accept numbers only, a regex check so
failure codes stay categories rather than quoted values, and a DDL event
trigger that refuses any new column named like `%ocr%`, `%national_id%` or
`%storage_key%`. Dropping it is a deliberate, logged act.

**Bans never touch IP addresses.** `BlocklistType` has no network member and a
CHECK constraint rejects one even if somebody adds it to the enum later. Campus
NAT and carrier CGNAT put thousands of students behind one address. Bans anchor
on user ID, email hash, phone hash (permanent) and device fingerprint (180
days, because fingerprints are inherited by second-hand phones).

**The automated pipeline cannot ban.** `decide()` has three outcomes —
`VERIFIED`, `RETAKE`, `NEEDS_REVIEW` — and no `BANNED`. Every ban is issued by
a named moderator at `/admin/moderation` with a written reason and an audit
row. This is a GDPR Art. 22 requirement, not a preference.

### Two things worth arguing about before you ship

1. **Flagged documents survive for up to 24 hours.** They have to: a moderator
   cannot review an image that was deleted. They are encrypted with a per-case
   key that is stored nowhere, parked in Redis under a hard TTL, and destroyed
   the instant a decision is made. This is the one place the retention promise
   is bounded rather than absolute, and it is called out rather than buried.

   > **Deployment requirement:** that Redis must run with `save ""` and
   > `appendonly no`. With RDB snapshots on, it writes ID scans to `dump.rdb`
   > and the guarantee silently breaks. Highest-risk operational assumption in
   > the system.

2. **The same forged document can be reused on a new account.** Keeping no
   document hash is what the zero-retention rule costs. The blocklist anchors
   on email, phone and device, all of which a determined attacker rotates.
   Closing it means retaining an irreversible HMAC of the ID number under
   legitimate interest — one column and one lookup, plus a DPIA entry. It is
   a product decision, deliberately left open.

## Other deviations from the brief

1. New passwords use **argon2id**, not bcrypt — bcrypt truncates at 72 bytes,
   and a long Azerbaijani passphrase exceeds that in UTF-8, so two different
   passwords can collide. bcrypt hashes still verify and upgrade on next login.
2. **Graduation month is required, not optional.** The 1 May sweep needs both
   halves of the date to know whether someone graduating "in 2026" has actually
   graduated by the time the job runs.
3. **Images are downscaled in the browser** before the 5 MB cap applies. Phone
   cameras produce 4–9 MB JPEGs, so a naive cap would reject most honest
   submissions. Long edge to 2000px (~300 DPI for an ID card) costs nothing in
   OCR accuracy and strips EXIF GPS as a side effect.

The document integrity scanner on `/register` is a **progress surface**, not
the check itself — but it now runs during the real request rather than on a
timer, because verification is synchronous. The analysis is in
`services/doc-verifier/app/main.py` (FFT moire detection, ELA + ORB copy-move,
EXIF, OCR); the decision is in `src/lib/verification/policy.ts`. That service
returns **scores and category codes only** — never the extracted name or ID
number — which is what keeps document text out of Node logs and APM traces.
