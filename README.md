# CampusNoteHub

A platform where verified university students in Azerbaijan share study notes, find mentors and connect with their campus community.

**Live site:** https://www.campusnotehub.com

## What it is

CampusNoteHub is a web app for university students. Students register and prove they are enrolled by uploading their student documents. Once verified, they can post in a campus feed, buy and sell study notes, and book paid one-on-one sessions with mentors. Administrators review documents, uploaded notes and mentor applications so that everyone on the platform is a real student.

The interface is available in Azerbaijani (default), English and Russian.

## Main features

- **Accounts and sign-in:** registration with email and password, secure sessions, a temporary lockout after repeated failed logins, and rate limits on sensitive actions.
- **Student verification:** documents are uploaded during registration. Clear cases are decided automatically and unclear ones go to a moderator. Documents are kept only while a case waits for review, and are deleted automatically within 7 days.
- **Campus feed:** posts with images, comments, likes and reporting.
- **Notes:** students upload free or paid study notes, which are reviewed before they are published. Buyers can download the file and see their purchases.
- **Mentors:** students can apply to become mentors. Approved mentors appear in a directory where others can view their profile and book a time slot.
- **Wallet:** an internal balance used to buy notes and book mentors, with transaction history.
- **Profile, settings and notifications:** a personal profile, account and language settings, in-app notifications, and emails for important events.
- **Admin panel:** dashboard statistics, the verification queue, review of notes and mentor applications, user management (suspend, ban, end sessions), university management, and an audit log that can be exported to Excel.

User roles are student, teacher, moderator and admin.

## Technology

- Next.js 15.5 (App Router), React 19, TypeScript
- Tailwind CSS
- Firebase Firestore, accessed through the Firebase Admin SDK
- Cloudinary for file storage
- Vercel for hosting and scheduled jobs
- Email through Gmail on one mailbox (supportcampushub@gmail.com) - SMTP out
  via Nodemailer, IMAP in - authenticated with a Google App Password
- argon2 for password hashing, jose for session tokens, Zod for input validation
- A separate Python (FastAPI) document-checking service in `services/doc-verifier`

## Architecture

- **One Next.js app** serves both the pages and the API (`src/app`).
- **Firestore is the only database.** All reads and writes happen on the server; the browser never talks to Firestore directly. Security rules and index definitions are in `firebase/`.
- **Sign-in is built into the app** rather than using Firebase Authentication. Passwords are hashed with argon2id, and sessions use secure, HTTP-only cookies holding a short-lived access token and a longer-lived refresh token.
- **Files live in Cloudinary** as private assets: post images, uploaded notes and documents waiting for review.
- **Document checks** are done by the separate Python service, which returns scores only, never the document's contents. If the service cannot be reached, the submission goes to manual review instead of failing.
- **Money movements** are recorded as double-entry ledger transactions in Firestore, so every balance change has a matching record.

## Production

- Hosted on Vercel at https://www.campusnotehub.com, also reachable at https://campusnotehub.com.
- Configuration comes from environment variables set in the Vercel project. `.env.example` lists the variable names; real values are never committed.
- One Vercel cron job (`/api/cron/verification-cleanup`) runs daily to delete expired review documents.

For local development: copy `.env.example` to `.env`, fill in the values, then run `npm install` and `npm run dev`. Before deploying, run `npm run typecheck`, `npm test` and `npm run build`.

## Project status

Registration and verification, the feed, notes, mentors, the wallet and the admin panel are implemented. Known gaps:

- **No real payment provider.** Wallet top-ups are a placeholder that adds balance without charging a card.
- **Some background jobs do not run on Vercel.** Releasing held funds to note sellers and mentors, booking reminders, retrying failed emails and the yearly graduation check run in a separate scheduler process (`npm run worker:scheduler`) that the Vercel deployment does not start.
- **Placeholder pages.** Explore, Bookmarks, Bookings, Help, About, Contact, the Terms, Privacy and Security pages, and the admin Reports page show an "under construction" screen. Reports on feed posts are saved, but there is no admin page to review them yet.
- **The document checker is hosted separately.** It is not part of the Vercel deployment; whenever it is unreachable, every submission goes to manual review.
- **The old name remains in places.** The app interface still says "CampusHub", and mentor video-call links point to `meet.campushub.com`.
- **`docs/` is out of date.** It describes an earlier PostgreSQL and Redis version of the project.