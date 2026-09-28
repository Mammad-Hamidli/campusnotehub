import type { NextRequest } from 'next/server';
import { passwordSignup, signupMethodNotAllowed } from '@/lib/auth/password-signup';

export const runtime = 'nodejs';

/** POST-only; see signupMethodNotAllowed(). */
export async function GET() {
  return signupMethodNotAllowed();
}

export const HEAD = GET;

/**
 * POST /api/auth/register  -  single-step student registration.
 *
 * Six fields: name, nickname, university, personal email, phone, password.
 * Mentors register at POST /api/auth/register/mentor; both run the same
 * implementation in src/lib/auth/password-signup.ts.
 */
export async function POST(request: NextRequest) {
  return passwordSignup(request, 'student');
}
