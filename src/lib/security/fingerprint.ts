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
