import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_REFRESHED,
  REFRESH_COOKIE_PATH,
  clearSessionCookies,
} from '@/lib/auth/session';

/**
 * Cookie invariants for the session pair.
 *
 * These are regression tests for two bugs that both presented as "logging out
 * did not log me out", and neither of which any existing test could have
 * caught, because both live entirely in the Set-Cookie ATTRIBUTES rather than
 * in any branch of logic.
 */

/** The Set-Cookie lines a response will actually send. */
function setCookies(response: NextResponse): string[] {
  return response.headers.getSetCookie();
}

function forName(response: NextResponse, name: string): string[] {
  return setCookies(response).filter((line) => line.startsWith(`${name}=`));
}

describe('clearSessionCookies', () => {
  /**
   * The bug: ResponseCookies.set() is keyed by NAME, so expiring CH_RT at
   * /api/auth and then at / emitted ONE header - the second call replaced the
   * first. The only header sent was for `/`, which matches nothing, so the
   * refresh token at /api/auth survived a sign-out that reported success.
   */
  it('expires the refresh token at the path it was actually written to', () => {
    const lines = forName(clearSessionCookies(NextResponse.next()), COOKIE_REFRESH);

    expect(lines.some((line) => line.includes(`Path=${REFRESH_COOKIE_PATH}`))).toBe(true);
    // ...and still covers a token written at the root by an older deploy.
    expect(lines.some((line) => /Path=\/(;|$)/.test(line))).toBe(true);
  });

  it('expires every auth cookie, including the refresh marker', () => {
    const response = clearSessionCookies(NextResponse.next());

    for (const name of [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_REFRESHED]) {
      const lines = forName(response, name);
      expect(lines.length, `${name} must be cleared`).toBeGreaterThan(0);
      expect(lines.every((line) => line.includes('Max-Age=0'))).toBe(true);
    }
  });

  it('keeps the auth cookies HttpOnly while clearing them', () => {
    const response = clearSessionCookies(NextResponse.next());
    expect(setCookies(response).every((line) => /HttpOnly/i.test(line))).toBe(true);
  });

  /**
   * CH_LOCALE is not an auth cookie and must survive a sign-out, or the
   * interface language silently resets every time someone logs out. This is
   * why /logout sends Clear-Site-Data without "cookies".
   */
  it('does not touch cookies it does not own', () => {
    const response = NextResponse.next();
    response.cookies.set('CH_LOCALE', 'en', { path: '/' });
    clearSessionCookies(response);

    expect(forName(response, 'CH_LOCALE')).toHaveLength(1);
    expect(forName(response, 'CH_LOCALE')[0]).toContain('CH_LOCALE=en');
  });
});
