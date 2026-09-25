/**
 * A human label for a stored User-Agent: "Chrome · Windows", "Safari · iPhone".
 *
 * Deliberately small - the Devices list only needs to let someone recognise
 * their own laptop and phone, not fingerprint anything. Order matters: Edge
 * and Opera also claim Chrome, and Chrome also claims Safari.
 */
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export type DeviceDescription = { browser: string | null; os: string | null; mobile: boolean };

export function describeUserAgent(ua: string | null | undefined): DeviceDescription {
  const value = ua ?? '';
  return {
    browser: BROWSERS.find(([pattern]) => pattern.test(value))?.[1] ?? null,
    os: SYSTEMS.find(([pattern]) => pattern.test(value))?.[1] ?? null,
    mobile: /Mobi|iPhone|Android(?!.*Tablet)/.test(value),
  };
}
