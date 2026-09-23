import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { constantTimeEqual, hashToken, newOpaqueToken } from '@/lib/crypto/hash';
import { open, seal } from '@/lib/crypto/vault';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { docToObject, forFirestore } from '@/lib/firebase/convert';
import { flowOrigin } from '@/lib/app-url';
import {
  OAuthError,
  profileFromClaims,
  type ProviderConfig,
  type ProviderId,
  type ProviderProfile,
} from './providers';

/**
 * The authorization-code flow, hardened.
 *
 * ===========================================================================
 * WHAT EACH PIECE DEFENDS AGAINST
 * ===========================================================================
 *  state     CSRF on the callback. Random, single-use, stored SERVER-SIDE with
 *            everything the callback needs (provider, intent, return path,
 *            redirect URI), so nothing the callback acts on comes from the URL.
 *  binding   LOGIN CSRF. `state` alone proves the flow was started by US, not
 *            by the browser now finishing it: an attacker could start a flow,
 *            sign in with their own Google account, and send the victim the
 *            callback URL - logging the victim into the attacker's account,
 *            where anything they upload lands in attacker-readable hands. A
 *            random cookie set on this browser at start, whose hash the state
 *            stores, makes a callback from any other browser fail.
 *  PKCE      Code interception. The code is useless without the verifier,
 *            which never leaves this server (sealed in the state document).
 *  nonce     id_token replay/injection. The token must carry the nonce this
 *            flow generated; only its hash is stored.
 *
 * The binding cookie is scoped to /api/auth/oauth and lives ten minutes, so it
 * is sent nowhere else. It is SameSite=Lax: Google returns through a top-level
 * GET navigation, which carries a Lax cookie, and Lax keeps the cookie off
 * every cross-site subresource request - see http.ts.
 */

export const BINDING_COOKIE = 'CH_OAUTH';
export const BINDING_COOKIE_PATH = '/api/auth/oauth';
const STATE_TTL_MS = 10 * 60_000;

export type OAuthIntent = 'login' | 'link';

export type OAuthState = {
  provider: ProviderId;
  intent: OAuthIntent;
  /** link only: who is linking, from which session. */
  userId: string | null;
  sessionId: string | null;
  verifierSealed: string | null;
  nonceHash: string;
  bindingHash: string;
  uaHash: string;
  redirectUri: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
};

const states = () => adminDb().collection(COLLECTIONS.oauthStates);
const uaHash = (ua: string) => hashToken(`oauth-ua:${ua}`);
const base64url = (buf: Buffer) => buf.toString('base64url');

/** Only same-origin paths; anything else falls back to the default. */
export function safeReturnTo(value: unknown, fallback = '/dashboard'): string {
  return typeof value === 'string' && /^\/(?![/\\])[^\s]*$/.test(value) && value.length <= 512 ? value : fallback;
}

/**
 * The redirect URI must be byte-identical at authorize and token time, and
 * registered with the provider. It comes from APP_URL, never from the Host
 * header - a spoofed Host must not be able to steer where codes are sent.
 * A loopback request outside production uses its own origin (see flowOrigin),
 * and local development without APP_URL falls back to it too.
 */
export function redirectUriFor(provider: ProviderId, requestOrigin: string): string {
  const base = flowOrigin(requestOrigin);
  if (!base && process.env.NODE_ENV === 'production') throw new OAuthError('config', 'APP_URL is not set');
  return `${base || requestOrigin}/api/auth/oauth/${provider}/callback`;
}

export async function beginAuthorization(params: {
  config: ProviderConfig;
  intent: OAuthIntent;
  userId?: string;
  sessionId?: string;
  returnTo: string;
  userAgent: string;
  requestOrigin: string;
}): Promise<{ url: string; binding: string }> {
  const { config } = params;
  const state = newOpaqueToken();
  const nonce = newOpaqueToken();
  const binding = newOpaqueToken();
  const stateHash = hashToken(state);
  const redirectUri = redirectUriFor(config.id, params.requestOrigin);

  // 32 random bytes -> 43 base64url chars: the RFC 7636 minimum length, and
  // the full entropy the spec asks for.
  const verifier = config.pkce ? base64url(randomBytes(32)) : null;
  const now = new Date();

  await states()
    .doc(stateHash)
    .create(
      forFirestore({
        provider: config.id,
        intent: params.intent,
        userId: params.userId ?? null,
        sessionId: params.sessionId ?? null,
        verifierSealed: verifier ? seal(Buffer.from(verifier), { purpose: 'pkce', state: stateHash }) : null,
        nonceHash: hashToken(`oauth-nonce:${nonce}`),
        bindingHash: hashToken(`oauth-binding:${binding}`),
        uaHash: uaHash(params.userAgent),
        redirectUri,
        returnTo: params.returnTo,
        createdAt: now,
        expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      } satisfies OAuthState),
    );

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  if (verifier) {
    url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  // Always show the account picker: silently reusing whichever Google account
  // the browser last used is how people link the wrong one.
  url.searchParams.set('prompt', 'select_account');

  return { url: url.toString(), binding };
}

export type ConsumedState = OAuthState & { verifier: string | null };

/**
 * Burns the state and checks it belongs to this browser. Returns null for
 * anything unacceptable - the caller answers every such case identically.
 *
 * Deleted in the SAME transaction that reads it, so a state is honoured at
 * most once even when a callback is replayed or double-submitted.
 */
export async function consumeState(params: {
  state: string | null;
  provider: ProviderId;
  binding: string | undefined;
  userAgent: string;
}): Promise<ConsumedState | null> {
  if (!params.state || !/^[A-Za-z0-9_-]{43}$/.test(params.state)) return null;
  const stateHash = hashToken(params.state);
  const ref = states().doc(stateHash);

  const record = await adminDb().runTransaction(async (tx) => {
    const found = docToObject<OAuthState>(await tx.get(ref)) as (OAuthState & { id: string }) | null;
    if (found) tx.delete(ref);
    return found;
  });

  // Every check runs AFTER the delete, so a rejected callback - including one
  // arriving without the binding cookie - still spends the state.
  if (!record || !params.binding) return null;
  if (record.expiresAt <= new Date()) return null;
  if (record.provider !== params.provider) return null;
  if (!constantTimeEqual(record.bindingHash, hashToken(`oauth-binding:${params.binding}`))) return null;
  if (!constantTimeEqual(record.uaHash, uaHash(params.userAgent))) return null;

  const verifier = record.verifierSealed
    ? open(record.verifierSealed, { purpose: 'pkce', state: stateHash }).toString()
    : null;
  return { ...record, verifier };
}

// ---------------------------------------------------------------------------
// Token exchange and verification
// ---------------------------------------------------------------------------

function clientSecret(config: ProviderConfig): string {
  switch (config.id) {
    case 'google':
      return process.env.GOOGLE_CLIENT_SECRET ?? '';
  }
}

/**
 * Exchanges the code for tokens and returns ONLY the id_token. The access
 * token is discarded unread: this app needs to know who signed in, not to act
 * on their provider account, and a token it never stores cannot leak.
 */
export async function exchangeCode(config: ProviderConfig, state: ConsumedState, code: string): Promise<string> {
  if (code.length > 2048) throw new OAuthError('exchange', 'code too long');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: state.redirectUri,
    client_id: config.clientId,
    client_secret: clientSecret(config),
  });
  if (state.verifier) body.set('code_verifier', state.verifier);

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    throw new OAuthError('exchange', 'network');
  }
  // Status only: the body of a failed exchange can echo the code.
  if (!response.ok) throw new OAuthError('exchange', `status ${response.status}`);
  const json = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (typeof json?.id_token !== 'string') throw new OAuthError('exchange', 'no id_token');
  return json.id_token;
}

const jwks = new Map<ProviderId, ReturnType<typeof createRemoteJWKSet>>();
function keySet(config: ProviderConfig) {
  let set = jwks.get(config.id);
  if (!set) {
    set = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
    jwks.set(config.id, set);
  }
  return set;
}

/**
 * Verifies the id_token and maps it to a profile.
 *
 * Signature against the provider's published keys (RS256 only - no `none`,
 * no HMAC confusion), audience = our client id, expiry with a minute of skew,
 * issued within the last ten minutes, and the nonce this flow generated.
 * The issuer rule lives in profileFromClaims().
 */
export async function verifyIdToken(
  config: ProviderConfig,
  idToken: string,
  nonceHash: string,
): Promise<ProviderProfile> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet(config), {
      audience: config.clientId,
      algorithms: ['RS256'],
      clockTolerance: 60,
      maxTokenAge: '10m',
    }));
  } catch {
    throw new OAuthError('token', 'signature or claims');
  }
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
  if (!nonce || !constantTimeEqual(hashToken(`oauth-nonce:${nonce}`), nonceHash)) {
    throw new OAuthError('token', 'nonce');
  }
  return profileFromClaims(config.id, payload as JWTPayload & Record<string, unknown>);
}
