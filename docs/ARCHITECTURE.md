# campusnotehub — Technical Blueprint

Three products on one identity spine: **Feed** (academic social timeline),
**UniNotes** (peer-to-peer study-note marketplace), **PocketMentor** (1-on-1
mentorship booking). What makes them one platform rather than three is the
verification layer — a verified student identity is the thing all three trade
on.

---

## 1. System topology

```
                        ┌──────────────────────────┐
 Browser / PWA ────────▶│  CDN + WAF (CloudFront)  │
                        └────────────┬─────────────┘
                                     │  multipart: 4 files, 5 MB each
                        ┌────────────▼─────────────┐
                        │  Next.js 15 (App Router) │  web tier
                        │  SSR · API · PIPELINE    │  role: campusnotehub_app
                        │  documents live HERE,    │
                        │  in RAM, for ~5 seconds  │
                        └──┬─────────┬─────────┬───┘
                           │         │         │
        ┌──────────────────┘         │         └──────────────────┐
        │                            │                            │
┌───────▼────────┐   ┌───────────────▼──────────────┐   ┌─────────▼─────────┐
│  PostgreSQL 16 │   │            Redis             │   │   S3 (2 buckets)  │
│  + btree_gist  │   │  rate limit · BullMQ ·       │   │  public · notes   │
│  + pg_trgm     │   │  REVIEW BUFFER (≤24h, enc,   │   │                   │
│                │   │  persistence DISABLED)       │   │  NO kyc bucket    │
│ flags + scores │   └───────────────┬──────────────┘   │  (by design)      │
│ never a doc    │                   │                  └───────────────────┘
└───────▲────────┘                   │
        │                 ┌──────────▼───────────┐
        │                 │  Worker / cron tier  │   notes PDF · notifications
        └─────────────────┤  NEVER sees a doc    │   payouts · 1 May sweep
                          └──────────────────────┘

                        ┌──────────────────────┐
        mTLS, private ──▶│  doc-verifier (py)   │  OpenCV · tesseract
        subnet, no       │  no DB · no disk ·   │  in-memory only
        egress           │  no egress           │  returns SCORES ONLY
                        └──────────────────────┘
```

**The one structural rule:** there is no stored corpus of identity documents to
protect. A web-tier RCE yields verification flags and confidence scores. The
documents it might want lived in RAM for a few seconds and were overwritten.
See [SECURITY.md](SECURITY.md).

### Tier responsibilities

| Tier | Runs | Holds ID docs | For how long |
|---|---|---|---|
| Edge middleware | CSP nonce, JWT signature check | no | — |
| Web (Next.js) | SSR, API routes, verification pipeline | in RAM | one request |
| doc-verifier | image forensics, OCR, cross-checks | in RAM | one request |
| Redis | encrypted review buffer, flagged cases only | ciphertext | <= 24h |
| Worker / cron | payouts, reminders, graduation sweep | **never** | — |

---

## 2. Repository layout

```
prisma/
  schema.prisma                 # 34 models; zero-retention rules in the header
  manual/
    0001_invariants.sql         # ledger, booking-overlap, FTS
    0002_zero_retention.sql     # DDL trigger + CHECKs that ENFORCE the policy
  seed.ts                       # 18 AZ universities, tags, ledger accounts
messages/
  az.json  en.json  ru.json     # 393 keys × 3, parity-checked in CI
scripts/
  check-i18n.mjs                # locale bundles agree with each other
  check-keys-used.mjs           # bundles agree with the code
src/
  middleware.ts                 # CSP nonce + auth gate (+ /admin)
  lib/
    db.ts
    permissions.ts              # the capability table behind the banner
    i18n/                       # cookie locale, SSR-resolved, client-switched
    auth/session.ts             # split access/refresh, rotation + reuse detect
    crypto/{hash,vault}.ts      # peppered HMAC · KMS envelope (meeting URLs)
    storage/s3.ts               # notes + public only; no KYC bucket
    security/
      blocklist.ts              # account + device bans. NO IP handling
      fingerprint.ts            # device identity, with its limits documented
      ratelimit.ts              # sliding window; IP used here and only here
    verification/
      fileValidation.ts         # magic bytes, dimensions, PDF safety, wipe()
      policy.ts                 # pure decide(); has no BANNED outcome
      pipeline.ts               # in-memory orchestration + guaranteed wipe
      reviewBuffer.ts           # encrypted, TTL-bound, flagged cases only
    wallet/ledger.ts
    mentors/{availability,meeting}.ts
    notifications/dispatch.ts
    queue/connection.ts         # lazy Redis; nothing dials at module scope
  server/
    cron/graduation.ts          # the 1 May sweep
    cron/scheduler.ts           # buffer reaper + sweep safety net
    validators/auth.ts
  app/
    page.tsx  register/  dashboard/  admin/moderation/
    api/{auth,verification,feed,mentors,admin}/
  components/{marketing,register,dashboard,admin,mentors,ui}/
services/doc-verifier/          # FastAPI, stateless, scores-only responses
```

## 3. Localisation

Default **az**, plus **en** and **ru**. The locale lives in the `CH_LOCALE`
cookie, is resolved server-side in the root layout so the first paint is
already correct, and switches client-side with no navigation.

Trade-off, stated because it is real: a cookie locale means `/` serves three
languages and search engines index one. For public SEO the marketing pages want
`/az`, `/en`, `/ru` prefixes. `/register`, `/dashboard` and `/admin` are
`noindex` anyway.

Three decisions worth keeping:

- **Notifications store locale keys, not rendered text.** A student who signs
  up in Azerbaijani and later switches to English gets their whole notification
  history in English rather than a permanent language mix. Cost: changing a
  message rewrites history. Right trade for transactional notices.
- **Two CI gates, not one.** `check-i18n.mjs` proves the three bundles agree
  with each other (keys and ICU placeholders); `check-keys-used.mjs` proves
  they agree with the code. The first catches a placeholder that exists in `en`
  but not `az` and throws at render time in Azerbaijani only; the second
  catches a raw `landing.hero.badge` shipped to a live page.
- **Layout assumes 30% text expansion.** AZ and RU strings run well past their
  English equivalents. No fixed-width labels, no truncation, `min-w-0` on every
  flex child that holds translated text.

---

## 4. Registration and verification

### Funnel

The two steps are **decoupled in time**. Signing up does not touch a document;
verification happens whenever the user chooses, in **Settings -> Verification**
(`/settings?tab=verification`; `/verify` is a redirect kept for old links).

```
Sign-up   POST /api/auth/register        (JSON only, no files)
          -> account created, session issued, status = UNVERIFIED
          -> device fingerprint recorded (NOT an IP address)
          -> user lands in the product immediately

          ... minutes, or days ...

Verify    POST /api/verification/submit  (multipart, 2 or 4 files)
          -> consent checked FIRST, before any byte is read
          -> validate bytes -> analyse in memory -> decide -> WIPE
          -> returns 200 with a real verdict in 3-8 seconds
```

**Why they are decoupled.** Verification used to be the last step of the
registration wizard, which meant a stranger who had not yet seen the product
was asked to find a national ID and photograph four card faces before owning an
account. That is where the funnel died. Nothing about the verification *rules*
changed - the capability table in `permissions.ts` refuses every money-moving
or 1-on-1 capability to an unverified account (see section 5). Only the queue
in front of the product was removed.

An account that is not VERIFIED sees a banner at the top of every page
([`IdentityPrompt.tsx`](../src/components/account/IdentityPrompt.tsx)), mounted
before `{children}` in the root layout. It has no close button: the state it
reports is real and blocking, and a dismissal that hides a blocking state is
how "why can't I buy notes" becomes a support ticket. UNVERIFIED and REJECTED
get a "Verify now" link; PROCESSING and NEEDS_REVIEW get an "in review" status
with no action. It disappears only at VERIFIED. It sits in the page flow rather
than being pinned, so it does not stack with each page's own sticky header.

### Account types and what each proves

| Registers as | Role written | Identity (national ID) | Enrolment (student card) |
|---|---|---|---|
| Student, currently studying | `STUDENT` | required | required |
| Student, graduated | `ALUMNI` | required | — |
| Mentor | `MENTOR` | required | — |

The rule lives once, in
[`requirements.ts`](../src/lib/verification/requirements.ts)
(`requiredKindsFor(role)`), which both the settings screen and
`POST /api/verification/submit` use, always from the **stored** role.

A mentor also picks their weekly availability at signup (a fourth wizard step,
mentors only). It is stored as a draft on the user and prefills
`/mentors/apply`; bookings read only the approved mentor profile's rules.

Registration offers exactly **two** choices, Student and Mentor. `TEACHER`
remains a `UserRole` an administrator can assign, but it is no longer a signup
option: it was validated by the same refinements, asked for the same fields and
required the same documents as `MENTOR`, so the choice changed nothing.

`ALUMNI` is **concluded, not claimed**. A student registration carries an
`academicStatus` of `STUDYING` or `GRADUATED`, asked in the same block as the
university because it is the same question - which institution, and are you
still there. `GRADUATED` is written as `ALUMNI` by the register route, with
`alumniTransitionedAt` stamped so the 1 May sweep does not prompt a transition
that already happened. The status and the graduation date must agree, enforced
by a refinement in `registerSchema`: "graduated, finishing in 2029" would
otherwise produce an alumni account that could never be verified, because it
would be asked for a student card it does not hold.

### Where consent is taken

Consent to process identity documents is collected in the settings
verification section, at the moment
the documents are handed over - not at signup. Consent given before the
processing is specified is not valid consent for special-category data under
GDPR Art. 9 or the AZ personal data law, and signup no longer mentions a
document at all. `POST /api/verification/submit` refuses a body without
`consentDocumentProcessing`, before reading a single file.

There is no presigned upload and no background queue. The documents go straight
from the browser into the request handler's memory and are overwritten before
the response is written.

### Zero retention

Identity documents are **never** written to S3 or to a database column. The
full rationale, the enforcement mechanisms, and the one bounded exception are
in [SECURITY.md section 3](SECURITY.md#3-zero-retention). The short version:

- auto-approved and auto-rejected cases: documents wiped in a `finally` block
  before the HTTP response;
- flagged cases: encrypted into Redis under a hard TTL (default 24h) so a
  moderator can actually review them, then gone;
- what survives: `isVerified`, `verifiedAt`, a confidence number, and category
  codes like `SCREEN_RECAPTURE`. No name, no ID number, no image, no hash.

This cost us the ability to detect the same forged document across accounts —
a real trade, documented as a residual gap rather than hidden.

### Hybrid AI + human decision

`decide()` in [`policy.ts`](../src/lib/verification/policy.ts) is a pure
function with exactly three outcomes:

| Outcome | Meaning | Attempt consumed |
|---|---|---|
| `VERIFIED` | confidence >= 0.88, no integrity or consistency signals | yes |
| `RETAKE` | quality only (blur, glare, crop) | **no** |
| `NEEDS_REVIEW` | anything ambiguous or suspicious | yes |

**The automated stage has no `BANNED` outcome.** Every ban is issued by a named
moderator in the admin console, with a written reason and an audit row. This is
a legal requirement (GDPR Art. 22 human intervention), a statistical one (the
best detector false-positives on cheap phone cameras), and a product one (a
false ban costs a student their wallet balance with no self-service recovery).

Quality failures do not burn attempts. Burning an attempt on a blurry photo is
how you generate support tickets from honest users.

### Anti-fraud without IP bans

`BlocklistType` has no network member, and a CHECK constraint rejects one even
if added to the enum later. Bans anchor on:

| Identifier | Duration |
|---|---|
| user ID, email hash, phone hash | permanent |
| device fingerprint | 180 days (expiry enforced by CHECK constraint) |

Device blocks expire because a fingerprint is inherited by second-hand phones
and shared lab machines. IP addresses are used for rate limiting only — see
[SECURITY.md section 4](SECURITY.md#4-anti-fraud-without-ip-banning).

### Graduation automation

A single cron on **1 May at 06:00 Asia/Baku**
([`graduation.ts`](../src/server/cron/graduation.ts)):

```
0 2 1 5 *   node dist/server/cron/graduation.js   # 02:00 UTC = 06:00 Baku
```

It sweeps users whose graduation date has been reached or passed and who have
not transitioned, prompts them, and stamps `graduationPromptedAt` in the same
transaction as the notification — so a re-run the same day is a no-op. Keyset
pagination in batches of 500; a partial index keeps it to a few thousand rows.

"Still studying" reschedules +1 year rather than cancelling: a cancelled prompt
leaves the account a "student" forever, which is the problem the feature exists
to solve.

## 5. Capability model

The "Account Unverified" banner is backed by one table
([`permissions.ts`](../src/lib/permissions.ts)):

| Capability | Unverified | Verified |
|---|---|---|
| read feed, post, comment | ✅ | ✅ |
| browse notes | ✅ | ✅ |
| browse mentors | ✅ | ✅ |
| **buy notes** (and review them) | ❌ | ✅ |
| **wallet top-up** | ❌ | ✅ |
| **sell notes** | ❌ | ✅ |
| **book a mentor** | ❌ | ✅ |
| **offer mentorship** | ❌ | ✅ |
| **withdraw funds** | ❌ | ✅ |

The line: unverified users get the full social product; verification unlocks
everything that moves money or puts two strangers in a private call. Spending
(buying notes, and with it wallet top-up, since money loaded but unspendable
would just sit in the wallet) moved behind verification so that every
transaction has a verified person on both sides. A refusal caused only by
verification returns `verification.restricted.action` (`denialKey()`), and the
UI answers it with a link to the settings section; every other refusal stays
the generic `errors.forbidden`.

---

## 6. Modules

### Feed

Keyset pagination on `(createdAt DESC, id DESC)`, never `OFFSET` — offset
re-reads and discards every earlier row, so page 50 costs 50× page 1, and posts
created mid-scroll shift the window and duplicate items.

Visibility (`PUBLIC` / `UNIVERSITY_ONLY` / `VERIFIED_ONLY` / `FOLLOWERS`) is
enforced **in the SQL where-clause**, not by filtering results in JS. A post the
viewer may not see never leaves the database. `UNIVERSITY_ONLY` resolves to the
author's own university server-side; a client-supplied `universityId` would let
anyone post into any university's feed.

### UniNotes

Upload → presigned S3 POST → `PROCESSING` → worker renders a **watermarked,
low-DPI page-1 preview** to the public bucket, extracts text for search,
computes SHA-256 for duplicate detection → `PENDING_REVIEW` → `PUBLISHED`.

Originals live in a private bucket and are only ever served through 120-second
signed URLs carrying the buyer's name in `Content-Disposition`, so a link
forwarded to a group chat is traceable.

Search uses a generated `tsvector` with `'simple'` config (no stemmer we
haven't configured for Azerbaijani) plus a `pg_trgm` index for fuzzy title
matching.

### PocketMentor

Availability is stored as weekly rules in **minutes from local midnight, in the
mentor's timezone**, plus date exceptions. Mentors are often alumni working
abroad and mentees are in a fourth timezone, so every value crossing a boundary
is an absolute instant; nothing touching the database is a wall-clock string.

Double-booking is prevented by a **GiST exclusion constraint** on
`(mentorId, tstzrange(startsAt, endsAt))` filtered to live statuses. The
application-level check exists only to produce a good error message — the
constraint is the guarantee under concurrency.

Video calls use self-hosted Jitsi with per-booking JWTs issued only inside a
30-minute window around the session, mentor as moderator. A plain Zoom link is
a bearer credential anyone can forward, and these are 1-on-1 calls with
students.

---

## 7. Money

Double-entry ledger. Every movement is a set of signed legs summing to zero,
posted inside one transaction, with a unique `referenceKey` making each posting
exactly-once — a retried purchase hits a unique violation instead of charging
twice. A **deferred constraint trigger** rejects any unbalanced transaction, so
a bug in application code cannot commit half a transfer. `ledger_entries` is
append-only, enforced by trigger.

Wallet balance columns are a denormalised cache; the ledger is the truth, and
`reconcile()` runs nightly. Drift is a bug and must page someone, not
self-heal.

Sellers are paid into `USER_PENDING` and clear after 72 hours. Without the
window, the fraud is trivial: upload someone else's copyrighted PDF, buy it
from a second account, withdraw before the takedown lands. Mentorship money
sits in `PLATFORM_ESCROW` until the session completes, so a no-show is
refundable without clawing back a withdrawn balance.

---

## 8. Notifications

`Notification` row (in-app, always) → BullMQ fan-out → Web Push (VAPID) and/or
email (Gmail SMTP). Enqueued *after* the DB write inside the same transaction, so a
rolled-back transaction can never deliver a push.

Per-type, per-channel preferences, with two overrides: security notices
(verification outcomes) and the 1-hour session reminder always send. A missed
paid session is a refund and a support ticket.

---

## 9. Frontend conventions

- Server Components by default; `'use client'` only where there's state or a
  browser API. The feed list, note cards and mentor directory are server-rendered.
- Design tokens in `tailwind.config.ts`, not scattered in classNames, so three
  locales × two themes stay in sync.
- Verification status is communicated by **icon + text + colour**, never colour
  alone.
- Banner is `role="status"`, not `role="alert"` — ambient state shouldn't
  interrupt a screen reader on every page load.
- Mobile-first at 360px. Desktop adds a reading column (`max-w-reader`) for
  notes; mobile optimises the feed column (`max-w-feed`).
- Client-side image checks (resolution, Laplacian blur) are a UX affordance
  only — every one is repeated server-side. They exist to fail a bad photo in
  200ms instead of after a 9 MB upload, which is the biggest lever on
  completion rate for that screen.

---

## 10. Deployment

| Component | Runs on | Scaling |
|---|---|---|
| Next.js web | ECS Fargate / Vercel | horizontal, stateless |
| Workers | ECS Fargate, private subnet | per-queue depth |
| doc-verifier | ECS Fargate, private subnet, no egress | queue depth |
| Postgres | RDS Multi-AZ, PITR | read replica for feed |
| Redis | ElastiCache | single primary + replica |

CI gates: `typecheck` → `lint` → `check-i18n` → `vitest` → `prisma migrate
diff` → build. The i18n check is a build gate, not a warning.

---

## 11. Deliberate deviations from the brief

1. **bcrypt → argon2id for new hashes.** bcrypt silently truncates at 72 bytes;
   a 24-character Azerbaijani passphrase exceeds that in UTF-8, so two
   different passwords can collide. bcrypt verification is retained and hashes
   upgrade transparently on next login — no migration, no forced reset.
2. **Model output cannot auto-ban** (§4). Deterministic evidence still bans
   instantly, as specified.
3. **IP blocklisting expires after 30 days** (§4), because of CGNAT and campus
   NAT. Document and identity blocks stay permanent.

Items 2 and 3 are judgement calls about false-positive blast radius, not
refusals — both are single-constant changes (`policy.ts`,
`IP_BLOCK_TTL_DAYS`) if you want the stricter behaviour.
