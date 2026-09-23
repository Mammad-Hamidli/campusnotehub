import type { JWTPayload } from 'jose';

/**
 * Google as an OpenID Connect provider: configuration, and the one function
 * that turns a VERIFIED id_token's claims into the facts the rest of the app
 * may rely on.
 *
 * Pure - no network, no database - so the rules that decide account linking
 * are unit-testable (see providers.test.ts).
 *
 * Google is the ONLY provider. The registry is still keyed by id so every
 * route, repository and UI reads the list rather than hardcoding a name, which
 * is what keeps `providers.length === 0` (no credentials configured) a
 * supported state instead of a broken screen.
 */

export const PROVIDER_IDS = ['google'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: 'Google',
};

export type ProviderConfig = {
  id: ProviderId;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  scope: string;
  /** Proof Key for Code Exchange (RFC 7636), which Google documents for web apps. */
  pkce: boolean;
};

const env = (name: string) => process.env[name]?.trim() || '';

/**
 * A provider is ENABLED only when every credential it needs is present, so a
 * half-configured deployment hides the button instead of failing mid-flow.
 */
export function providerConfig(id: ProviderId): ProviderConfig | null {
  switch (id) {
    case 'google': {
      const clientId = env('GOOGLE_CLIENT_ID');
      if (!clientId || !env('GOOGLE_CLIENT_SECRET')) return null;
      return {
        id,
        clientId,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
        scope: 'openid email profile',
        pkce: true,
      };
    }
  }
}

export function enabledProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => providerConfig(id) !== null);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export class OAuthError extends Error {
  constructor(
    readonly code: 'claims' | 'exchange' | 'token' | 'config',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export type ProviderProfile = {
  provider: ProviderId;
  /** Stable, provider-scoped account id. The ONLY thing an identity is keyed on. */
  subject: string;
  email: string | null;
  /** The provider asserts the person controls `email`. */
  emailVerified: boolean;
  /**
   * May this identity be matched to an EXISTING account by email? Requires a
   * verified email from a provider whose verification means something.
   */
  linkableByEmail: boolean;
  firstName: string | null;
  lastName: string | null;
};

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

function cleanEmail(v: unknown): string | null {
  const email = str(v)?.trim().toLowerCase() ?? null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/**
 * Claims -> profile, for a token whose SIGNATURE, audience, expiry and nonce
 * have already been verified (flow.ts). This adds the issuer rule and decides
 * what may be trusted.
 */
export function profileFromClaims(
  provider: ProviderId,
  claims: JWTPayload & Record<string, unknown>,
): ProviderProfile {
  switch (provider) {
    case 'google': {
      if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
        throw new OAuthError('claims', 'google issuer');
      }
      const subject = str(claims.sub);
      if (!subject) throw new OAuthError('claims', 'google sub');
      const email = cleanEmail(claims.email);
      /**
       * `email_verified` must be the BOOLEAN true. Google sends a real boolean;
       * accepting the string "true" as well would widen what counts as proof of
       * a mailbox, and that proof is what rule 2a in callback.ts links on.
       */
      const emailVerified = !!email && claims.email_verified === true;
      return {
        provider,
        subject,
        email,
        emailVerified,
        linkableByEmail: emailVerified,
        firstName: str(claims.given_name),
        lastName: str(claims.family_name),
      };
    }
  }
}
