import { NextResponse, type NextRequest } from 'next/server';
import { type Locale } from '@/lib/enums';
import { updateUser } from '@/lib/firebase/repositories/users';
import { requireSession } from '@/lib/auth/session';
import { isLocale } from '@/lib/i18n/dictionaries';

export const runtime = 'nodejs';

/**
 * PATCH /api/me/locale — persist the language choice to the user's profile.
 *
 * This endpoint was already being called by LocaleProvider.setLocale() but had
 * never been created, so every language switch logged a 404. The call site
 * swallows the failure, which is why the switcher still appeared to work: the
 * CH_LOCALE cookie is what actually survives a reload. What was silently lost
 * is the half the cookie cannot do — carrying the choice to another device, and
 * telling the notification workers which language to send email in.
 *
 * ANONYMOUS CALLERS GET 204, NOT 401.
 *
 * The language switcher is on the register and login pages, where nobody is
 * signed in yet. Answering 401 there would just trade a 404 in the console for
 * a 401 in the console, and an unauthenticated language switch is not an error:
 * the cookie has already done the whole job. There is nothing to report and
 * nothing for the client to handle, so this is a no-content success.
 */
export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const locale = (body as { locale?: unknown } | null)?.locale;

  // Reuses the same guard the root layout uses to validate the cookie, so the
  // set of accepted languages cannot drift between the two.
  if (!isLocale(locale)) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  await updateUser(userId, { locale: locale as Locale });

  return new NextResponse(null, { status: 204 });
}
