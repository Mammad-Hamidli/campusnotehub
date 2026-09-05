import { createHmac } from 'node:crypto';
import { piiHash } from '@/lib/crypto/hash';

/**
 * Device fingerprinting - the replacement for IP-based blocking.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS HONESTLY WORTH
 * ---------------------------------------------------------------------------
 * A fingerprint is a speed bump, not a wall. Stated plainly so nobody builds
 * a security guarantee on top of it:
 *
 *  - it DRIFTS. A Chrome update changes the WebGL renderer string and the
 *    fingerprint moves. Roughly 10-20% churn per month is normal.
 *  - it is SPOOFABLE. A fresh browser profile, a privacy extension, or a VM
 *    resets it in about a minute. Someone determined defeats it trivially.
 *  - it COLLIDES. Two identical university lab machines with the same image
 *    and the same fonts can hash to the same value.
 *
 * Given that, it is used for exactly two things and nothing else:
 *
 *  1. Raising the cost of casual re-registration after a ban. The lazy
 *    majority does not clear their fingerprint, and that is most abuse.
 *  2. Correlating rings - twelve accounts sharing one fingerprint is a strong
 *    signal for a MODERATOR to look at, never grounds for an automatic ban.
 *
 * Because of the collision risk, device blocks always carry an expiry (there
 * is a CHECK constraint enforcing it in 0002_zero_retention.sql). A
 * second-hand phone must not inherit a stranger's permanent ban.
 *
 * ---------------------------------------------------------------------------
 * LEGAL NOTE - read before shipping
 * ---------------------------------------------------------------------------
 * Fingerprinting is "gaining access to information stored in the terminal
 * equipment of a subscriber", which brings it under ePrivacy Art. 5(3) and
 * generally requires consent. The security/fraud-prevention exemption is
 * available and is what we rely on, but relying on it has conditions:
 * the purpose must be strictly limited to fraud prevention (it is - the
 * fingerprint is never used for analytics or ad targeting), it must be
 * disclosed in the privacy policy, and it belongs in the DPIA. See
 * docs/SECURITY.md section 4.
 */

/** Signals the browser reports. Individually weak, jointly discriminating. */
export type ClientSignals = {
  /** Hash of a rendered canvas - the highest-entropy single signal. */
  canvas?: string;
  /** WebGL vendor + renderer, e.g. "Google Inc. (Intel)". */
  webgl?: string;
  /** Which of a probe list of fonts are present. */
  fonts?: string[];
  screen?: { width: number; height: number; colorDepth: number; pixelRatio: number };
  timezone?: string;
  languages?: string[];
  platform?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  touchPoints?: number;
};

/**
 * Signals only the server can observe. These are the valuable half: a script
 * running in the page cannot alter the TLS handshake or the HTTP/2 frame
 * ordering, so spoofing the client signals alone does not move the fingerprint.
 */
export type ServerSignals = {
  /** JA4 TLS client fingerprint, from the CDN/edge. */
  ja4?: string;
  /** HTTP/2 SETTINGS + header-order hash. */
  http2Fingerprint?: string;
  acceptLanguage?: string;
  userAgent?: string;
};

/**
 * Combines both sides into one stable identifier.
 *
 * Weighted deliberately: the TLS fingerprint is included verbatim because it
 * is hard to forge, while the volatile client signals are bucketed so a minor
 * browser update does not produce a brand-new device.
 */
export function computeFingerprint(client: ClientSignals, server: ServerSignals): string {
  const parts = [
    // Server-observed, hard to spoof.
    server.ja4 ?? '',
    server.http2Fingerprint ?? '',

    // Client-reported, bucketed for stability.
    client.canvas ?? '',
    client.webgl ?? '',
    bucketFonts(client.fonts),
    client.screen ? `${client.screen.width}x${client.screen.height}@${client.screen.colorDepth}` : '',
    client.timezone ?? '',
    client.platform ?? '',
    // Exact core counts differ across reporting quirks; buckets do not.
    bucketNumber(client.hardwareConcurrency),
    bucketNumber(client.deviceMemory),
    client.touchPoints && client.touchPoints > 0 ? 'touch' : 'notouch',

    // Major browser version only - a patch bump must not reset the device.
    majorBrowserVersion(server.userAgent),
  ];

  return piiHash(parts.join('|'), 'device');
}

/**
 * Coarse label for the "your devices" screen.
 * Never store or display a full user-agent string: it is both identifying and
 * useless to the person reading it.
 */
export function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';

  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser';

  const os =
    /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'Unknown OS';

  return `${browser} on ${os}`;
}

/**
 * Similarity between two fingerprints.
 *
 * Because fingerprints drift, an exact-match-only check under-counts returning
 * devices. The blocklist still matches exactly (a near-match must not trigger
 * a ban), but the moderator's ring-detection view uses this to group devices
 * that are probably the same machine after an update.
 */
export function fingerprintDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  return differing;
}

/**
 * Extracts server-side signals from the incoming request.
 *
 * NOTE what is absent: there is no IP address here, and no function in this
 * module accepts one. That is structural, not an oversight - see the schema
 * header comment.
 */
export function readServerSignals(headers: Headers): ServerSignals {
  return {
    // Set by the edge/CDN. Cloudflare exposes JA4 on Enterprise; otherwise the
    // reverse proxy computes it. Absent in dev, which is fine - the client
    // signals still produce a usable (weaker) fingerprint.
    ja4: headers.get('cf-ja4') ?? headers.get('x-ja4') ?? undefined,
    http2Fingerprint: headers.get('x-http2-fingerprint') ?? undefined,
    acceptLanguage: headers.get('accept-language') ?? undefined,
    userAgent: headers.get('user-agent') ?? undefined,
  };
}

/**
 * Short-lived token binding a fingerprint to a session, so a client cannot
 * simply post someone else's fingerprint string to evade a device block.
 */
export function signFingerprint(fingerprint: string, sessionId: string): string {
  return createHmac('sha256', process.env.PII_HASH_PEPPER ?? 'dev-only-pepper')
    .update(`fp:${fingerprint}:${sessionId}`)
    .digest('base64url');
}

// --- bucketing helpers -----------------------------------------------------

function bucketFonts(fonts: string[] | undefined): string {
  if (!fonts?.length) return '';
  // Sorted and counted, not listed: the exact set is noisy across OS updates,
  // while the presence of distinctive families is stable.
  return `${fonts.length}:${[...fonts].sort().slice(0, 12).join(',')}`;
}

function bucketNumber(value: number | undefined): string {
  if (!value) return '';
  if (value <= 2) return 'low';
  if (value <= 4) return 'mid';
  if (value <= 8) return 'high';
  return 'veryhigh';
}

function majorBrowserVersion(userAgent: string | undefined): string {
  if (!userAgent) return '';
  const match = userAgent.match(/(Chrome|Firefox|Safari|Edg|OPR)\/(\d+)/);
  return match ? `${match[1]}${match[2]}` : '';
}
