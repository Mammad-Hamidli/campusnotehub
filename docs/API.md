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

**`POST /auth/register`** — JSON only. This endpoint accepts **no files**;
identity documents belong to `/verification/submit`, which the user reaches
when they choose to.

```jsonc
{
  "accountType": "STUDENT",      // STUDENT | MENTOR — the only two on offer
  "firstName": "Aysel",
  "lastName": "Məmmədova",
  "dateOfBirth": "2003-04-19",
  "nickname": "aysel_m",
  "email": "aysel@ada.edu.az",
  "password": "…",               // ≥ 12 chars, ≥ 5 distinct
  "passwordConfirm": "…",
  "universityId": "ADA",         // university CODE, not a document id
  "phone": "+994501234567",      // required; strongest ban anchor we have

  // ---- STUDENT only ----
  "academicStatus": "STUDYING",  // STUDYING | GRADUATED
  "studentNumber": "20231234",
  "facultySlug": "computer-science",
  "facultyOther": "…",           // required iff facultySlug === "other"
  "graduationYear": 2026,
  "graduationMonth": 5,          // required - the 1 May sweep needs both halves

  // ---- MENTOR only ----
  "department": "Azercell",      // organisation
  "academicTitle": "Senior PM",  // position
  "availability": [              // required, >= 1 slot; refused for STUDENT
    { "weekday": 1, "startMinute": 1080, "endMinute": 1260 }  // 0=Sun, 30-min steps
  ],
  "timezone": "Asia/Baku",       // IANA zone the availability is in

  "locale": "az",
  "acceptTerms": true,
  "deviceFingerprint": "…"       // client half only; combined server-side with TLS JA4
}
```

`academicStatus: "GRADUATED"` writes the account as **`ALUMNI`**, not
`STUDENT`, and stamps `alumniTransitionedAt`. The status and the graduation
date must agree (a graduate's date cannot be in the future, a current
student's cannot be in the past) or the request is a `400` on
`graduationYear`.

`universityId` is required for `STUDENT` and **optional for `MENTOR`** (often
an industry professional). When sent, it must still be a known, seeded code.

A mentor's `availability` is normalised like `POST /mentors/apply` (overlaps
merged) and stored on the user as `mentorAvailability` - a DRAFT: nothing is
bookable until the mentor application is approved. `GET /mentors/apply`
returns it as `draft: { availability, timezone }` so the application form opens
with the grid already painted.

`consentDocumentProcessing` is **no longer read here** — it moved to
`/verification/submit`, where the processing it consents to actually happens.
It is still accepted and ignored so a stale client is not broken mid-rollout.

→ `201` `{ user: { id, verificationStatus }, next: { step: "VERIFY_DOCUMENTS", href: "/verify" } }`
→ `409` `auth.errors.nicknameTaken` | `auth.errors.credentialsUnavailable` (email and phone share one message on purpose — see the route)
→ `403` `verification.failure.generic` (blocklisted — same generic body as any other rejection)

---

## Verification

| Method | Path | Auth | Limit | Notes |
|---|---|---|---|---|
| `POST` | `/verification/submit` | session | 3 / day | **multipart**, 2 or 4 files by role. Runs the whole pipeline inline. |
| `GET` | `/verification/status` | session | — | `{ status, attempt, remainingAttempts, messageKey }` |
| `POST` | `/me/graduation` | session | — | Answers the alumni prompt: `alumni` \| `still_studying` \| `later`. |

There is **no** `/verification/presign`. Documents no longer go to object
storage, so there is nothing to presign. See
[SECURITY.md §3](SECURITY.md#3-zero-retention).

**`POST /verification/submit`** — `multipart/form-data`. Which parts are
required is decided from the account's **stored role**, never from anything the
client sends, so a caller cannot shrink its own requirements:

```
consentDocumentProcessing   "true"  — required; checked before any file is read

ID_FRONT                    image/jpeg | image/png | application/pdf, <= 5 MB
ID_BACK                     "

STUDENT_CARD_FRONT          "   — STUDENT only
STUDENT_CARD_BACK           "   — STUDENT only
```

`MENTOR`, `TEACHER` and `ALUMNI` submit the national ID alone: none of them
holds a *current* student card, so demanding one would make their verification
impossible to complete. Every other role also proves enrolment, which is the
conservative default.

Without `consentDocumentProcessing: "true"` the request is a `400`
(`auth.errors.consentRequired`) and no byte of any file is read.

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

### Account deletion requests

A user cannot delete their own account; they file a request that an **ADMIN**
reviews. Approving runs the same soft delete as `DELETE /admin/users/:id`
(`softDeleteAccount()` in `src/lib/accounts/softDelete.ts`), including the
self-action and last-admin guards.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/me/deletion-request` | session | The caller's request, or `null`. |
| `POST` | `/me/deletion-request` | session, 5 / day | `{ password, reason? }`. Re-checks the password; `409` if one is already pending. Notifies every ADMIN in-app (and by email) with a link to the queue. |
| `DELETE` | `/me/deletion-request` | session | Cancels a `PENDING` request. |
| `GET` | `/admin/deletion-requests?status=PENDING` | ADMIN | Queue, oldest first, with the account's wallet balance (available + escrow). |
| `PATCH` | `/admin/deletion-requests/:userId` | ADMIN | `{ decision: "APPROVE" \| "REJECT", reason? }`. A rejection needs a reason (≥ 5 chars); it is emailed to the user. |

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
| `PUT` | `/mentors/:id/reviews` | session + `mentors:book` | 30 / h | `{ rating: 1-5, body? }`, create or update. See below. |

**`POST /mentors/:id/bookings`**
```jsonc
{ "startsAt": "2026-03-20T10:00:00.000Z", "topic": "…", "menteeNote": "…",
  "idempotencyKey": "<uuid>" }
```
→ `409` `mentors.errors.slotTaken` (lost the race — the GiST exclusion
constraint is authoritative) · `409` `mentors.errors.tooSoon` · `402`
insufficient funds

**`PUT /mentors/:id/reviews`** — the same mechanics as
`PUT /notes/:id/reviews`, with a finished session in place of a PAID order.
Eligible when the caller has a `CONFIRMED` / `RESCHEDULED` / `COMPLETED`
booking with this mentor whose `endsAt` has passed, re-read inside the review
transaction. One review per mentee per mentor (id `mentorId__menteeId`), so
rating again replaces the old review. `ratingSum` / `ratingCount` / `ratingAvg`
on the mentor profile update in the same transaction. `GET /mentors/:id` carries
`viewerReview: { eligible, rating, body }` for the review box.
→ `403` `mentors.reviewForm.errors.sessionRequired` · `403`
`verification.restricted.action` (unverified) · `404` unapproved mentor

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
