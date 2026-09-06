# CampusHub — Security & Data Protection

CampusHub verifies students against national ID cards. Those documents belong
to people who are mostly 17–22 years old. This document explains how the
platform avoids holding them.

> **What changed in this revision.** The previous design encrypted identity
> documents into an S3 bucket and purged them 30 days after a decision, and it
> banned fraudsters by IP. Both were wrong. Sections 3 and 5 explain why and
> what replaced them.

---

## 1. Threat model

| Adversary | Goal | Primary control |
|---|---|---|
| Fake-account farmer | Sell notes / pose as a mentor | Hybrid verification, account + device blocklist |
| Credential stuffer | Take over accounts | Argon2id, 5/15min limit, session rotation with reuse detection |
| Scraper | Bulk-download paid notes | 120s signed URLs, per-buyer `Content-Disposition` |
| **Web-tier attacker (RCE / SSRF)** | **Exfiltrate the ID document corpus** | **There is no corpus — see §3** |
| Malicious insider | Browse ID scans | Per-case decryption secrets, mandatory audit rows, 24h TTL |
| Upload-based attacker | RCE via crafted file | Magic-byte sniffing, PDF active-content rejection, decompression-bomb caps |

The fourth row used to be the hardest problem in the system. It is now close to
trivial, because the thing being protected does not exist for more than a few
seconds.

---

## 2. Hybrid verification pipeline

```
browser ──multipart──▶ POST /api/verification/submit   (Node, in memory)
                            │
                            ├─ validate bytes  (magic bytes, dimensions, PDF safety)
                            │
                            ├──mTLS──▶ doc-verifier   (Python, in memory, no disk)
                            │            moire · ELA · copy-move · EXIF · OCR
                            │            ◀── scores + category codes ONLY
                            │
                            ├─ decide()  ── VERIFIED ──▶ wipe, respond
                            │            ── RETAKE   ──▶ wipe, respond
                            │            └─ NEEDS_REVIEW
                            │                   │
                            │                   ├─ encrypt → Redis, TTL ≤24h
                            │                   └─ wipe
                            └─ finally { wipe every buffer }
```

### The decision policy

`decide()` in [`policy.ts`](../src/lib/verification/policy.ts) is a pure
function with three possible outcomes:

| Outcome | Meaning | Documents |
|---|---|---|
| `VERIFIED` | high confidence, no integrity or consistency signals | wiped immediately |
| `RETAKE` | quality only (blur, glare, crop) — **does not consume an attempt** | wiped immediately |
| `NEEDS_REVIEW` | anything ambiguous or suspicious | encrypted, ≤24h, then gone |

**There is no `BANNED` outcome.** The automated stage cannot ban. Every ban is
issued by a named moderator through the admin panel, against a case they
opened, with a written reason and an audit row.

Three reasons, in order of how much they should stop you from changing it:

1. **Legal.** An automated ban is a decision with legal effect produced solely
   by automated processing. GDPR Art. 22 and the equivalent AZ provision give
   the subject a right to human intervention. Putting the human *before* the
   sanction rather than after an appeal is the only version that scales.
2. **Statistical.** The strongest detector is moire-based screen-recapture,
   and it fires on cheap phone cameras under fluorescent library lighting —
   which describes most of the target user base.
3. **Asymmetric cost.** A false approval is one moderation ticket, reversible.
   A false ban costs a student their account, their uploaded notes, and their
   wallet balance.

### Moderator review

The admin console ([`ModerationConsole.tsx`](../src/components/admin/ModerationConsole.tsx))
enforces the asymmetry in the UI: approve needs one click, reject and ban need
a typed reason of at least 10 characters, and ban needs a second confirmation.

Every document view writes an `AuditLog` row **before** the response is
streamed, so a crash mid-render still leaves the access recorded.

---

## 3. Zero retention

### The rule

National ID cards and student cards are **never** written to object storage or
to a database column. They exist as `Buffer` objects inside one HTTP request
and are overwritten with zeroes in a `finally` block.

### What is stored instead

The complete set, from the `User` table:

```prisma
verificationStatus     VerificationStatus
isVerified             Boolean
verifiedAt             DateTime?
studentStatusConfirmed Boolean
identityConfirmed      Boolean
```

Plus, on `VerificationCase`: the verdict, a confidence number, category codes
like `SCREEN_RECAPTURE`, and per-check numeric scores. No name, no ID number,
no date of birth, no image, no hash of an image.

### Why the old S3 design could not deliver this

The previous architecture encrypted documents into an S3 bucket with a 30-day
purge job. That is a *retention policy*, not zero retention, and it fails for
reasons no amount of care fixes:

- S3 versioning and lifecycle rules keep "deleted" objects recoverable, and the
  KYC bucket needed versioning for the dispute window;
- a queued analysis job means documents sit in storage for however long the
  queue is backed up — unbounded during an incident;
- backups snapshot the bucket, and you cannot selectively purge a backup.

Deleting the KMS key was the escape hatch, and cryptographic erasure is a real
technique — but it shreds *every* document at once, so it cannot serve a single
subject's erasure request. Not storing the document is simpler and stronger.

### Enforced, not promised

A policy that relies on every future developer remembering it is not a policy.
[`0002_zero_retention.sql`](../prisma/manual/0002_zero_retention.sql)
makes the database refuse:

- `checkScores` accepts **numeric values only** — a JSONB type check rejects any
  string, so the most tempting smuggling route ("just the name, for reviewer
  context") fails on write;
- `failureCodes` must match `^[A-Z][A-Z0-9_]{2,63}$` — a code is a category,
  never a quoted value from the document;
- a review buffer without an expiry is rejected, and the expiry cannot exceed
  72 hours;
- a DDL event trigger blocks any new column on `users` or `verification_cases`
  whose name matches `%ocr%`, `%national_id%`, `%storage_key%`, `%passport%`.

Dropping that trigger is a deliberate, logged, reviewable act — which is the
conversation we want to force.

### The one exception, stated plainly

Ambiguous cases go to a human, and a human cannot review a deleted image. So
flagged submissions — and **only** flagged submissions — are encrypted and
parked in Redis under a hard TTL. This is bounded four ways:

| Bound | Mechanism |
|---|---|
| Which cases | `NEEDS_REVIEW` only; approvals and retakes never reach it |
| Where | Redis with **RDB and AOF persistence disabled** — the blob never reaches a disk |
| How long | Redis-enforced TTL, default 24h, hard ceiling 72h |
| Who | Per-case AES-256-GCM key, returned once and **stored nowhere** — not in Postgres, not in Redis |

That last row is what makes a database compromise insufficient: the ciphertext
is in Redis, the key is in the moderator's queue entry, and neither alone is
useful.

> **Deployment requirement.** Redis must run with `save ""` and
> `appendonly no`. A Redis with RDB snapshots enabled would silently write ID
> scans to `dump.rdb` and break the entire promise. This is checked in the
> deployment smoke test, not left to the runbook.

### The residual gap, stated honestly

Because no document hash is retained, **the same forged student card can be
resubmitted on a new account**. The blocklist anchors on email, phone, device
and user ID, all of which a determined attacker can rotate.

Closing it would mean retaining an irreversible HMAC of the national ID number
— which is still personal data under GDPR Recital 26, but is not a document and
cannot be reversed into one. The lawful basis would be legitimate interest in
fraud prevention (Recital 47) with a defined retention period.

That is a deliberate product decision, not an oversight. It is not implemented
because the current spec calls for flags only. If you want it, it is one hash
column plus one lookup in `_cross_document_signals`, and it needs a DPIA entry.

---

## 4. Anti-fraud without IP banning

### Why IP banning was removed

The previous design blocklisted IP addresses on fraud detection. In this market
that is collective punishment with no upside:

- Azerbaijani dormitories and campuses sit behind a handful of NAT'd addresses;
- every local mobile carrier uses CGNAT, so one IPv4 routinely fronts thousands
  of subscribers;
- the fraudster reconnects on mobile data in thirty seconds, while an entire
  dormitory is locked out of signing up.

`BlocklistType` now has **no network member**, and a CHECK constraint rejects
`'IP'`, `'IP_CIDR'`, `'SUBNET'` and `'ASN'` even if someone adds one to the
enum later.

IP addresses are still used for **rate limiting**, which is a different thing:
temporary, burst-scoped, self-recovering.

### What replaced it

| Identifier | Duration | Rationale |
|---|---|---|
| `USER_ID` | permanent | the actual offender |
| `EMAIL_HASH` | permanent | cheap to rotate, still raises cost |
| `PHONE_HASH` | permanent | strongest anchor — SIM registration in AZ is identity-linked |
| `DEVICE_FINGERPRINT` | 180 days | see below |

Device blocks **must** carry an expiry — enforced by a CHECK constraint —
because a fingerprint outlives its owner. Second-hand phones and shared
university lab machines would otherwise inherit a stranger's permanent ban.

### What fingerprinting is honestly worth

Stated in [`fingerprint.ts`](../src/lib/security/fingerprint.ts) so nobody
over-trusts it:

- it **drifts** — a Chrome update changes the WebGL renderer string; expect
  10–20% monthly churn;
- it is **spoofable** — a fresh browser profile resets it in about a minute;
- it **collides** — identical lab machines with the same image can hash alike.

It is used for exactly two things: raising the cost of casual re-registration,
and correlating rings for a *human* to look at. Twelve accounts on one
fingerprint is a moderator ticket, never an automatic sanction — a computer lab
legitimately produces exactly that pattern.

Server-observed TLS (JA4) signals are mixed in because a script in the page
cannot alter the TLS handshake, so spoofing the JS signals alone does not move
the fingerprint.

### Legal note

Fingerprinting is access to information stored in terminal equipment, which
falls under ePrivacy Art. 5(3) and normally requires consent. We rely on the
security/fraud-prevention exemption. That reliance has conditions: the purpose
must be strictly limited to fraud prevention (it is — the fingerprint is never
used for analytics or targeting), it must be disclosed in the privacy policy,
and it belongs in the DPIA.

---

## 5. Upload security

Identity documents are the highest-risk input the platform accepts.

| Control | Value | Enforced in |
|---|---|---|
| Max size | **5 MB** per file, 20 MB total | client + server + stream cap |
| Allowed types | `image/jpeg`, `image/png`, `application/pdf` | **magic bytes**, not the client header |
| Min dimensions | 600px on the long edge | header parse, no decode |
| Max dimensions | 12000px / 50 MP | header parse, no decode |
| PDF | rejected if `/JavaScript`, `/Launch`, `/EmbeddedFile`, `/OpenAction`, `/XFA`, `/Encrypt` | byte scan |
| Polyglot | rejected if a second container signature appears past byte 64 | byte scan |

Three details that matter more than they look:

**Content-Type is never trusted.** `file.type` is a string the browser copies
from the extension. Type is derived from magic bytes in
[`fileValidation.ts`](../src/lib/verification/fileValidation.ts).

**Dimensions are read from the header without decoding.** A 40000×40000 PNG is
a few KB on disk and ~6 GB decoded — a one-request OOM kill. The PNG IHDR and
JPEG SOF parsers exist specifically to reject that before any decoder runs.

**PDFs are rasterised, not sanitised.** A PDF is a scripting environment. The
verifier renders page one to a bitmap and discards the original, so no PDF
feature survives to reach a moderator's browser.

### The 5 MB cap needed a client-side fix

A modern phone camera produces 4–9 MB JPEGs, so a naive 5 MB limit would reject
a large share of perfectly good photos with no actionable feedback. Every image
is downscaled in the browser first: long edge to 2000px (≈300 DPI for an ID-1
card, comfortably above what OCR needs), then JPEG quality stepped down until
it fits.

Side benefit: re-encoding strips EXIF, so the user proves they are a student
without also handing over the GPS coordinates of where they were standing.

---

## 6. Rate limiting

Sliding window in Redis, one round trip
([`ratelimit.ts`](../src/lib/security/ratelimit.ts)). A fixed window permits 2×
the limit across a boundary, which matters most on exactly these endpoints.

| Endpoint | Limit |
|---|---|
| `auth:login` | 5 / 15 min |
| `auth:register` | 3 / hour |
| `verification:submit` | 3 / day |
| `notes:upload` | 10 / day |
| `bookings:create` | 10 / day |
| `feed:post` | 20 / hour |
| `search` | 120 / min |

Keyed per user when authenticated, per hashed IP otherwise. Both are needed:
per-IP alone punishes a NAT'd campus, per-user alone is defeated by registering
more accounts. Client IP is read only from the CDN-set header — trusting a raw
`X-Forwarded-For` lets anyone spoof past a limit.

The verification limit is checked **before** the body is read, so a flood costs
a Redis round trip rather than 20 MB of buffering per request.

---

## 7. Legal basis and retention

| Data | Basis | Retention |
|---|---|---|
| Account (name, email, university) | Contract | Life of account + 30 days |
| **ID & student card images** | **Explicit consent** | **Seconds. Never persisted.** |
| Review buffer (flagged cases only) | Legitimate interest — fraud prevention | ≤24h, encrypted, RAM only |
| Verification flags | Contract | Life of account |
| Email / phone / device hashes | Legitimate interest | Permanent (device: 180 days) |
| Financial ledger | Legal obligation | 5 years |
| Audit log | Legal obligation | 3 years |

Under Azerbaijan's *Law on Personal Data* (No. 998-IIIQ) national ID data is
special-category; the same treatment satisfies GDPR Art. 9 for EU-resident
users, so the strict path is the only path implemented.

**Consent is a separate checkbox** from Terms acceptance. Bundling
biometric-adjacent document processing into a general ToS checkbox is not valid
consent under either regime and is worth nothing in a dispute.

### Subject rights

| Right | Endpoint | Note |
|---|---|---|
| Access | `GET /me/export` | Returns flags. There are no documents to return. |
| Rectification | `PATCH /me` | A name change reopens verification |
| Erasure | `DELETE /me` | Anonymises. Ledger rows and fraud hashes retained under legal obligation / legitimate interest, and the response says so |
| Portability | `GET /me/export` | |
| Objection | `POST /me/appeal` | Human review of a ban |

Erasure is unusually clean here: there is no document to erase, because there
never was one.

---

## 8. Application security

**Transport.** HTTPS only, HSTS `max-age=63072000; includeSubDomains; preload`.

**CSP.** Per-request nonce with `strict-dynamic`, set in
[`middleware.ts`](../src/middleware.ts). A host allowlist was rejected: it
degrades silently every time someone adds a CDN, and on the upload screen a
single injected script is a reportable breach.

**Passwords.** Argon2id (m=19456, t=2, p=1), 12-character minimum, no
composition rules (those produce `Parol123!`), plus a breach-list lookup.
bcrypt verify is retained for legacy hashes with transparent upgrade — bcrypt
is not used for new hashes because it truncates at 72 bytes, and a
24-character Azerbaijani passphrase exceeds that in UTF-8, so two distinct
passwords can collide.

**Sessions.** 15-minute EdDSA access JWT (claims: `sub`, `ver` only) plus an
opaque refresh token stored as an HMAC. Rotation on every use with **reuse
detection**: a spent refresh token means theft, so the whole family is revoked.

**Live revocation.** `requireSession()` reads live account state on every
request, so a ban takes effect immediately rather than after the token TTL.

**Native modules and secrets are lazy.** argon2/bcrypt are dynamically
imported and `PII_HASH_PEPPER` is resolved per call, because Next.js evaluates
route modules during build-time page-data collection — a module-scope `throw`
fails the build on every CI runner, and a top-level native import fails on any
image where the binary is not compiled for the platform.

**No socket at module scope.** All Redis access goes through `getRedis()`.
Constructing a client at import time dialled Redis during `next build`, opened
a connection on every serverless cold start, and hung test teardown.

---

## 9. Integrity invariants

Enforced in Postgres, not application code:

- `ledger_entries` sums to zero per transaction (deferred constraint trigger)
- `ledger_entries` is append-only (trigger rejects UPDATE/DELETE)
- `audit_logs` / `moderation_actions`: no UPDATE/DELETE grant for the app role
- No overlapping live bookings per mentor (GiST exclusion on `tstzrange`)
- `wallets.availableMinor >= 0`, `pendingMinor >= 0`
- `orders`: `price = platformFee + sellerNet`
- One open verification case per user (partial unique index)
- Everything in §3 under "Enforced, not promised"

---

## 10. Incident response

1. **Contain** — revoke the compromised credential. For a review-buffer
   incident, `FLUSHDB` on the Redis instance destroys every pending document
   immediately; there is no other copy.
2. **Assess** — the audit log answers "which moderator viewed which case, and
   when" exactly. There is no bulk document store to assess exposure of.
3. **Notify** — 72 hours to the supervisory authority. Note that the
   notification is unusually narrow: at most 24 hours of flagged cases could
   have been exposed, not the historical corpus.
4. **Rotate** — pepper rotation requires a planned re-hash; treat it as a
   migration.

---

## 11. Known gaps

Honest list for the next review:

- **No liveness check.** Someone holding a genuine ID belonging to another
  person passes every automated check. A selfie-with-document step closes this
  and adds real biometric processing — a deliberate deferral.
- **Forged documents are reusable across accounts** — see the residual gap in
  §3. Deliberate, and one hash column away from closed.
- **Fingerprint spoofing** is trivial for a motivated attacker (§4). The design
  assumes this and never bans on it alone.
- **Redis persistence is a deployment-time property.** The smoke test checks
  it, but a misconfigured managed Redis with snapshots enabled would break the
  retention guarantee silently. This is the highest-risk operational assumption
  in the system.
- **No formal DPIA yet.** Required before processing ID documents at scale.
  Fingerprinting and the review buffer both need entries.
