# Mentor registration and payment receipts

## Stored data

Firestore is the application database; there is no active SQL/ORM schema to migrate. The user record (`users/{userId}`) now includes:

```ts
mentorType: 'INDIVIDUAL' | 'COURSE'
mentorRegistrationStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null
courseEmail: string | null
courseTeachers: Array<{
  id: string; fullName: string; specialization: string; bio: string;
  avatarUrl: string | null; timezone: string; availability: WeeklyRule[]
}>
```

Individual accounts have no course email or teacher list. A course account requires one primary email and a teacher count from 2 to 30; registration creates that many blank instructor profile slots. The course account owner completes them from Settings, including each picture, bio, specialization, time zone and weekly timetable. At least two profiles are retained.

## Activation (payment first)

`mentorRegistrationStatus` is the account's **activation** state, for both mentor types:

| Status | Meaning |
| --- | --- |
| `PENDING` | Set at `/mentors/join`. The account has role `MENTOR` and can open the mentor panel (which shows a "pay the first fee" step), but `mentorSince` is `null`, `can(viewer, 'mentors:offer')` is false, `POST /api/mentors/apply` returns `403 mentors.payment.required`, an admin cannot approve its application (`409 mentors.payment.pendingForApproval`), and `POST /api/mentors/:id/bookings` refuses requests to it. |
| `APPROVED` | A moderator approved a payment receipt. The same transaction sets `mentorSince` (the fee clock starts on that day) and promotes a `STUDENT` role to `MENTOR`. |
| `REJECTED` | Treated like `PENDING`. Nothing writes it today. |
| `null` | Accounts that never went through `/mentors/join` (students, legacy mentors). Not gated. |

The role stays `MENTOR` from signup on purpose: a `STUDENT` role would put these accounts in the graduation cron and student counts. "Active" is decided by `mentorActivationPending()` in `src/lib/mentors/membership.ts`, not by the role. The mentor application decision no longer touches `mentorRegistrationStatus`.

Session request mail resolves to the primary `courseEmail`, falling back to the account email for individual mentors. The selected monthly amount is 10 AZN for individuals and 30 AZN for courses.

`mentorPaymentReceipts/{messageHash}` stores `userId`, `status` (`PENDING | APPROVED | INVALID`), sender, subject, receipt arrival time, attachment file names, and moderation decision metadata. Attachment bytes remain in the mailbox and are not copied to Firestore.

## HTTP contracts

- `POST /api/auth/register/mentor`: retains the existing account fields and adds required `mentorType`. Individual accounts provide their account email; Course accounts provide `courseEmail`, which is used as the account email and login address, plus `teacherCount` (integer 2-30). Course requests must omit `universityId`. Course teacher profile slots are created at registration and completed in Settings. The response keeps the existing `201` user and `next` shape. A manual transfer instruction email is queued after account creation.
- `GET /api/mentors/me/course-teachers`: course-account-only; returns the owner's instructor profiles.
- `PUT /api/mentors/me/course-teachers` with `{ "teachers": [{ "id?", "fullName", "specialization", "bio", "timezone", "availability" }] }`: validates and saves 2-30 instructor profiles. Avatar URLs are retained from server state and cannot be written by clients.
- `POST|DELETE /api/mentors/me/course-teachers/:teacherId/avatar`: upload or remove one instructor's processed profile picture, scoped to the signed-in course account.
- `GET /api/admin/mentor-payment-receipts?status=PENDING|APPROVED|INVALID`: moderator-only; returns up to 100 receipts ordered oldest first, each with its account (`nickname`, `fullName`, `email`, `mentorType`, `mentorRegistrationStatus`) or `user: null` for a deleted one.
- `PATCH /api/admin/mentor-payment-receipts/:receiptId` with `{ "decision": "APPROVED" | "INVALID" }`: moderator-only, idempotency protected by the pending-state check. `APPROVED` on an unactivated account activates it in the same transaction (see above); the response carries `activated: boolean`. Writes an audit log entry and sends the matching status email after the decision is saved; returns `409` if already reviewed. `INVALID` changes only the receipt.

The queue UI is at `/admin/mentor-payments` (Admin Panel → Mentor payments).

Replies to the payment instruction email are matched to the mentor account email and its subject, inserted into the payment receipt queue, and acknowledged using the receipt received template. The inbound mailbox cron drains once a day (Vercel Hobby only allows daily crons; `npm run email:inbox` drains on demand); it deduplicates by message id so repeated polling does not create another receipt or response. Moderators make the final decision through the endpoint above.

## Deployment configuration

Set `MENTOR_PAYMENT_BANK_NAME`, `MENTOR_PAYMENT_CARDHOLDER`, and `MENTOR_PAYMENT_CARD_NUMBER` to the official transfer details in the deployment environment. Mentor signup returns `503` until all three are configured. Set up `IMAP_USER`, `IMAP_PASSWORD`, and SMTP credentials as documented in `.env.example`; the mailbox drain must be enabled for receipt acknowledgement and review to work.
