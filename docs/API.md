# CampusHub — API Reference

All routes are under `/api`. JSON in, JSON out. Errors return
`{ "error": "<locale.key>", "params?": {...}, "fields?": {...} }` — the server
returns a LOCALE KEY, never a sentence, and the client resolves it through the
active dictionary. That way error text is localised without the server having
to know the viewer's language, and one wording change is one edit in
`messages/*.json` rather than a redeploy of every handler.

Auth: `CH_AT` cookie (EdDSA JWT, 15 min). `CH_RT` refresh cookie is scoped to
`/api/auth` and never sent on page requests.

Rate limits are sliding-window, keyed per user when authenticated and per
hashed IP otherwise. `429` responses carry `Retry-After`.

---

## Auth

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `POST` | `/auth/register` | — | 3 / h | Creates account, signs in, `verificationStatus = UNVERIFIED`. Returns `201` + `next.step`. |
| `POST` | `/auth/login` | — | 5 / 15 min | Constant-time on unknown email (no user enumeration). |
| `POST` | `/auth/refresh` | refresh cookie | 60 / h | Rotates. Reuse of a spent token revokes the whole family. |
| `POST` | `/auth/logout` | session | — | Revokes the current session only. |
| `POST` | `/auth/logout-all` | session | — | Revokes every session for the user. |
| `POST` | `/auth/password/forgot` | — | 3 / h | Always `204`, regardless of whether the email exists. |
| `POST` | `/auth/password/reset` | reset token | 5 / h | Single-use token, revokes all sessions on success. |
| `GET` | `/auth/me` | session | — | Viewer + capability flags for the client. |

**`POST /auth/register`**
```jsonc
{
  "fullName": "Aysel Məmmədova",
  "email": "aysel@ada.edu.az",
  "password": "…",              // ≥ 12 chars, ≥ 5 distinct
  "passwordConfirm": "…",
  "universityId": "clx…",
  "facultyId": "clx…",          // optional
  "phone": "+994501234567",      // optional; strongest ban anchor we have
  "graduationYear": 2026,
  "graduationMonth": 5,          // required - the 1 May sweep needs both halves
  "locale": "az",
  "acceptTerms": true,
  "consentDocumentProcessing": true,   // separate consent, not bundled
  "deviceFingerprint": "…"       // client half only; combined server-side with TLS JA4
}
```
→ `201` `{ user: { id, verificationStatus }, next: { step: "VERIFY_DOCUMENTS", href: "/verify" } }`
→ `409` `auth.errors.emailTaken` · `403` `verification.failure.generic` (blocklisted — same generic body as any other rejection)

---

## Verification

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `POST` | `/verification/submit` | session | 3 / day | **multipart**, 4 files. Runs the whole pipeline inline. |
| `GET` | `/verification/status` | session | — | `{ status, attempt, remainingAttempts, messageKey }` |
| `POST` | `/me/graduation` | session | — | Answers the alumni prompt: `alumni` \| `still_studying` \| `later`. |

There is **no** `/verification/presign`. Documents no longer go to object
storage, so there is nothing to presign. See
[SECURITY.md §3](SECURITY.md#3-zero-retention).

**`POST /verification/submit`** — `multipart/form-data`, four parts:

```
STUDENT_CARD_FRONT   image/jpeg | image/png | application/pdf, <= 5 MB
STUDENT_CARD_BACK    "
ID_FRONT             "
ID_BACK              "
```

The rate limit is checked **before** the body is read, so a flood costs a Redis
round trip rather than 20 MB of buffering. Every part is validated against its
actual bytes — magic-byte sniffing, header dimension parse, PDF active-content
scan — never against the client's declared `Content-Type`.

Returns `200` with a real verdict (this call is synchronous, 3–8s):

```jsonc
{
  "caseId": "clx…",
  "status": "VERIFIED" | "REJECTED" | "NEEDS_REVIEW",
  "attempt": 1,
  "remainingAttempts": 2,
  "messageKey": "verification.badge.verified"
}
```

Errors are specific for quality (they help an honest user) and generic for
anything fraud-adjacent (specifics would help a forger):

| Status | Body | Meaning |
|---|---|---|
| `400` | `verification.quality.*` | blurry, too small, wrong format, unsafe PDF |
| `403` | `verification.failure.generic` | blocklisted — same body as any other rejection |
| `409` | `verification.banner.needsReview` | a review is already open |
| `413` | `errors.fileTooLarge` | over 5 MB |
| `429` | `verification.banner.attemptsExhausted` | 3 decided attempts used |

Quality failures (`RETAKE`) do **not** consume an attempt.

---

## Moderation (role: `MODERATOR` / `ADMIN`)

Role is re-checked against **live database state** on every call — a JWT claim
can be 15 minutes stale and a demoted moderator must lose access immediately.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/verification/queue` | Flagged cases, priority desc then oldest first. No images, no secrets. |
| `GET` | `/admin/verification/:caseId?secret=…` | Streams the buffered images as `data:` URLs. **Writes an audit row before responding.** |
| `POST` | `/admin/verification/:caseId` | `{ decision: "APPROVE" \| "REJECT" \| "BAN", reason, codes }` |
| `POST` | `/admin/users/:id/unban` | Removes blocklist rows; keeps the audit trail. |
| `GET` | `/admin/reports` | Content report queue. |

The `secret` is the per-case AES key produced when the buffer was stashed. It
is **not stored in Postgres** — a database compromise alone cannot read pending
review documents out of Redis.

`GET` returns `410` with `admin.review.bufferExpired` once the TTL lapses. That
is a normal outcome, not an error: ask the applicant to resubmit.

`POST` destroys the documents **before** writing the decision. If the database
write then fails the state is "documents gone, case still open" — annoying but
safe. The reverse order would risk "decision recorded, documents still in
Redis", which nothing would ever clean up.

This is the only endpoint in the platform that can ban for document fraud. The
automated pipeline has no `BANNED` outcome.

---

## Feed

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `GET` | `/feed` | optional | 120 / min | Keyset paginated. |
| `POST` | `/feed` | session | 20 / h | Unverified users may post. |
| `GET` | `/feed/:postId` | optional | — | |
| `DELETE` | `/feed/:postId` | author / mod | — | Soft delete. |
| `POST` | `/feed/:postId/like` | session | 200 / h | Idempotent (composite PK). |
| `DELETE` | `/feed/:postId/like` | session | — | |
| `GET` | `/feed/:postId/comments` | optional | — | Threaded. |
| `POST` | `/feed/:postId/comments` | session | 60 / h | |
| `POST` | `/feed/:postId/report` | session | 10 / h | |
| `GET` | `/tags/trending` | optional | — | |
| `POST` | `/users/:id/follow` | session | — | |

**`GET /feed`** — `?cursor=<iso>_<id>&limit=20&filter=all|university|following&tag=examalert`
→ `{ posts: [...], nextCursor: "2026-03-14T09:12:00.000Z_clx…" | null }`

---

## UniNotes

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `GET` | `/notes` | optional | 120 / min | Full-text + facets. |
| `GET` | `/notes/:id` | optional | — | Preview only unless owned. |
| `POST` | `/notes` | session + `notes:sell` | 10 / day | Creates `DRAFT`, returns presigned PDF POST. |
| `POST` | `/notes/:id/finalize` | seller | — | Enqueues preview + text extraction → `PROCESSING`. |
| `PATCH` | `/notes/:id` | seller | — | Metadata only; re-uploading the file re-triggers review. |
| `DELETE` | `/notes/:id` | seller / mod | — | `DELISTED`; existing buyers keep access. |
| `POST` | `/notes/:id/purchase` | session | 30 / h | Requires `Idempotency-Key`. |
| `GET` | `/notes/:id/download` | owner | 20 / h | 302 → 120-second signed URL. |
| `POST` | `/notes/:id/reviews` | verified buyer | — | One per order. |
| `GET` | `/notes/purchases` | session | — | |

`GET /notes` facets: `universityId`, `subject`, `courseCode`, `language`,
`minPrice`, `maxPrice`, `minRating`, `freeOnly`, `sort=recent|popular|rating|price`.

**`POST /notes/:id/purchase`** → `201` `{ orderId, downloadUrl }`
→ `402` `notes.errors.insufficientFunds` · `409` already owned (returns the
existing order — safe to retry)

---

## PocketMentor

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `GET` | `/mentors` | optional | 120 / min | Filter by `industry`, `language`, `maxRate`, `minRating`. |
| `GET` | `/mentors/:id` | optional | — | |
| `POST` | `/mentors/apply` | verified | — | Creates unapproved `MentorProfile`. |
| `PUT` | `/mentors/me/availability` | mentor | — | Replaces the weekly rule set. |
| `POST` | `/mentors/me/exceptions` | mentor | — | Blackout dates. |
| `GET` | `/mentors/:id/bookings?date=&tz=` | optional | — | Slot grid for one day. |
| `POST` | `/mentors/:id/bookings` | session + `mentors:book` | 10 / day | Books + escrows in one transaction. |
| `GET` | `/bookings` | session | — | Both roles. |
| `POST` | `/bookings/:id/cancel` | participant | — | Full refund >24h out. |
| `POST` | `/bookings/:id/complete` | mentor | — | Releases escrow. |
| `GET` | `/bookings/:id/join` | participant | — | Jitsi JWT, only within ±30 min of the session. |
| `POST` | `/bookings/:id/review` | mentee | — | After `COMPLETED` only. |

**`POST /mentors/:id/bookings`**
```jsonc
{ "startsAt": "2026-03-20T10:00:00.000Z", "topic": "…", "menteeNote": "…",
  "idempotencyKey": "<uuid>" }
```
→ `409` `mentors.errors.slotTaken` (lost the race — the GiST exclusion
constraint is authoritative) · `409` `mentors.errors.tooSoon` · `402`
insufficient funds

---

## Wallet

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/wallet` | session | `{ availableMinor, pendingMinor, currency }` |
| `GET` | `/wallet/transactions` | session | Keyset paginated ledger view. |
| `POST` | `/wallet/topup` | session | Returns provider redirect. |
| `POST` | `/wallet/withdraw` | verified | Manual review above a threshold. |
| `POST` | `/webhooks/payments` | HMAC | Idempotent by provider event id. |

All amounts are **integer minor units (qəpik)**. No endpoint accepts or returns
a float for money.

---

## Notifications

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/notifications` | session | Keyset paginated; keys resolved in the viewer's locale. |
| `POST` | `/notifications/read` | session | `{ ids: [...] }` or `{ all: true }`. |
| `GET` | `/notifications/stream` | session | SSE for the unread badge. |
| `POST` | `/push/subscribe` | session | VAPID subscription. |
| `DELETE` | `/push/subscribe` | session | |
| `PUT` | `/notifications/preferences` | session | Per type × channel. |

---

## Reference data

| Method | Path | Notes |
|---|---|---|
| `GET` | `/universities` | Dropdown source; localised names. Cached 1 h. |
| `GET` | `/universities/:id/faculties` | |
| `PATCH` | `/me/locale` | Persists the header language choice to the profile. |

---

## Status codes

| Code | Meaning here |
|---|---|
| `202` | Verification submitted — decision is asynchronous |
| `402` | Insufficient wallet balance |
| `403` | Capability missing, or blocklisted (generic body) |
| `409` | Conflict: duplicate email, slot taken, already owned |
| `422` | Semantically invalid (e.g. graduation year out of range) |
| `429` | Rate limited — see `Retry-After` |
