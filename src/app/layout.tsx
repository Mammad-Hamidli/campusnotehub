import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/lib/i18n/dictionaries';
import { ThemeProvider } from '@/lib/theme/ThemeProvider';
import { SessionKeeper } from '@/components/auth/SessionKeeper';
// Imported from constants.ts, NOT from the 'use client' provider: a plain
// export read across that boundary resolves to undefined on the server.
// See src/lib/theme/constants.ts.
import {
  THEME_COOKIE,
  THEME_INIT_SCRIPT,
  isThemePreference,
  type ThemePreference,
} from '@/lib/theme/constants';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'latin-ext', 'cyrillic'], // latin-ext = AZ diacritics, cyrillic = RU
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://campushub.az'),
  title: {
    default: 'CampusHub — Notes, mentors and campus life',
    template: '%s · CampusHub',
  },
  description:
    'The verified platform for Azerbaijani university students: peer study notes, 1-on-1 mentorship with working professionals, and a campus feed.',
  openGraph: {
    type: 'website',
    siteName: 'CampusHub',
    locale: 'az_AZ',
    alternateLocale: ['en_US', 'ru_RU'],
    images: ['/brand/campus-hub-logo.svg'],
  },
  /**
   * The tab icon is NOT declared here on purpose.
   *
   * src/app/icon.svg and src/app/apple-icon.png are Next.js file conventions:
   * the framework hashes them, serves them from /icon.svg?<hash> and emits the
   * <link rel="icon"> tags itself. Repeating them in this object would produce
   * a second, unhashed set of tags pointing at the same artwork, and the two
   * would then have to be kept in step by hand.
   */
};

export const viewport: Viewport = {
  /**
   * These must track --canvas in globals.css. They colour the browser chrome
   * around the page (Android address bar, iOS status bar, the macOS Safari tab
   * strip), so a stale value shows up as a hairline of the OLD theme sitting
   * directly above the new one.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F8FB' },
    { media: '(prefers-color-scheme: dark)', color: '#111620' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();

  /**
   * CSP nonce minted by src/middleware.ts for this request.
   *
   * The theme script below is inline, and the policy uses 'strict-dynamic',
   * which makes the browser ignore 'self' and trust ONLY scripts carrying the
   * nonce. Without it the script is refused with
   *   Executing inline script violates the following Content Security Policy
   * and the refusal is silent to the user: `data-theme` keeps whatever value
   * SSR guessed, so anyone whose OS is dark gets a light page and the theme
   * control looks like it does nothing.
   */
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  // Both preferences resolve on the SERVER so the first paint is already
  // correct. A client-only read renders in the default language and light
  // theme, hydrates, then repaints — and the flash is very visible.
  const rawLocale = jar.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const rawTheme = jar.get(THEME_COOKIE)?.value;
  const themePreference: ThemePreference = isThemePreference(rawTheme) ? rawTheme : 'system';

  // 'system' cannot be resolved on the server — the OS preference is only
  // knowable in the browser — so SSR emits the light token set and the
  // blocking script below corrects it before the first paint.
  const ssrTheme = themePreference === 'dark' ? 'dark' : 'light';

  return (
    <html lang={locale} data-theme={ssrTheme} className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Synchronous and inline on purpose: anything deferred runs after the
            first paint, which is exactly the frame the user sees flash white. */}
        {/*
          suppressHydrationWarning is required on THIS element, not just <html>.

          React deliberately blanks the nonce when it serialises the tag, so the
          server HTML carries nonce="" while the hydrating client holds the real
          value - a mismatch React reports on every load:
            + nonce="MzFiOGU4..."   (client)
            - nonce=""              (server)
          The difference is intentional on React's side and harmless: the
          browser already read the real nonce off the wire and allowed the
          script. The warning on <html> does not cover it because
          suppressHydrationWarning only applies one level deep.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-dvh bg-canvas font-sans text-fg">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]
 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm
                     focus:font-medium focus:text-accent-fg"
        >
          Skip to content
        </a>
        <ThemeProvider initialPreference={themePreference}>
          <LocaleProvider initialLocale={locale}>
            <SessionKeeper />
            {children}
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
