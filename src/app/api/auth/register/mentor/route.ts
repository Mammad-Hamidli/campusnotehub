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
 * with role MENTOR and `mentorSince` = now, and signed in; the client is sent
 * to the mentor panel, whose checklist leads through verification, the
 * application (/mentors/apply) and approval. Nothing is listed in the mentor
 * directory until a moderator approves that application.
 */
export async function POST(request: NextRequest) {
  return passwordSignup(request, 'mentor');
}
