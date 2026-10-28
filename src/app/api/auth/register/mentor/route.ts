import type { NextRequest } from 'next/server';
import { passwordSignup, signupMethodNotAllowed } from '@/lib/auth/password-signup';

export const runtime = 'nodejs';

/** POST-only; see signupMethodNotAllowed(). */
export async function GET() {
  return signupMethodNotAllowed();
}

export const HEAD = GET;

/**
 * POST /api/auth/register/mentor  -  mentor registration, from /mentors/join.
 *
 * The student fields with the university optional. The account is created
 * with role MENTOR but INACTIVE (`mentorRegistrationStatus: PENDING`, no
 * `mentorSince`) and signed in; it is activated when a moderator approves its
 * payment receipt. The client is sent to the mentor panel, whose checklist
 * leads through payment, verification, the application (/mentors/apply) and
 * approval. Nothing is listed in the mentor
 * directory until a moderator approves that application.
 */
export async function POST(request: NextRequest) {
  return passwordSignup(request, 'mentor');
}
