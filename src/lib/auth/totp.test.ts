import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  base32Decode,
  base32Encode,
  formatSecretForManualEntry,
  hotp,
  newRecoveryCodes,
  normalizeRecoveryCode,
  normalizeTotpInput,
  otpauthUri,
  qrSvgDataUrl,
  totpStep,
  verifyTotp,
} from './totp';

/** The RFC 6238 appendix B seed for HMAC-SHA1. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('hotp / totp - RFC 6238 appendix B (SHA-1)', () => {
  // [unix seconds, 8-digit expected value from the RFC]
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('T=%i -> %s', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
    // Six digits are the low six of the same truncation.
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(expected.slice(-6));
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  const step = totpStep(now);

  it('accepts the current step and one either side, returning the matched step', () => {
    for (const delta of [-1, 0, 1]) {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + delta), now)).toBe(step + delta);
    }
  });

  it('rejects codes two steps away', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it('rejects anything that is not exactly six digits', () => {
    for (const bad of ['', '12345', '1234567', '12345a', ' 123456', '１２３４５６']) {
      expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
    }
  });

  it('accepts spaced or hyphenated input once normalised', () => {
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, normalizeTotpInput(`${code.slice(0, 3)} ${code.slice(3)}`), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, normalizeTotpInput(`${code.slice(0, 3)}-${code.slice(3)}`), now)).toBe(step);
  });
});

describe('base32 and provisioning', () => {
  it('encodes per RFC 4648 without padding', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.alloc(0))).toBe('');
  });

  it('decodes what it encodes, forgiving spaces and case', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    expect(base32Decode(formatSecretForManualEntry(secret).toLowerCase())).toEqual(secret);
    expect(() => base32Decode('ABC1')).toThrow();
  });

  it('builds an otpauth URI authenticator apps accept', () => {
    const uri = new URL(otpauthUri(RFC_SECRET, 'aysel_01', 'CampusHub'));
    expect(uri.protocol).toBe('otpauth:');
    // WHATWG URL reads the "totp" type as the host of a non-special scheme.
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/CampusHub:aysel_01');
    expect(uri.searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(uri.searchParams.get('issuer')).toBe('CampusHub');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('renders the QR code as an SVG data URL', () => {
    const url = qrSvgDataUrl('otpauth://totp/x?secret=ABC');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1], 'base64').toString()).toContain('<svg');
  });

  it('groups the manual-entry key in fours', () => {
    expect(formatSecretForManualEntry(Buffer.from('foobar'))).toBe('MZXW 6YTB OI');
  });
});

describe('recovery codes', () => {
  it('issues ten distinct codes in XXXX-XXXX-XXXX-XXXX form without look-alikes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it('normalises case, spaces and hyphens to one canonical form', () => {
    const [code] = newRecoveryCodes(1);
    const canonical = code.replace(/-/g, '');
    expect(normalizeRecoveryCode(code)).toBe(canonical);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.replace(/-/g, ' ')} `)).toBe(canonical);
  });

  it('rejects malformed codes before they cost a hash', () => {
    for (const bad of ['', 'ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMN-PQRS-TUVW', 'ABCD-EFGH-JKMN-PQR0', 'ABCD-EFGH-JKMN-PQRI']) {
      expect(normalizeRecoveryCode(bad)).toBeNull();
    }
  });
});
