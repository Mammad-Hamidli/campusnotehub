import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_DESKTOP_VERSION, desktopAppVersion, isNewerVersion } from './appVersion';

describe('isNewerVersion', () => {
  it.each([
    ['1.1.0', '1.0.1'],
    ['1.0.10', '1.0.9'],
    ['2.0.0', '1.99.99'],
    ['v1.2.0', '1.1.0'],
  ])('%s is newer than %s', (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(true);
  });

  it.each([
    ['1.0.1', '1.0.1'],
    ['1.0.0', '1.0.1'],
    ['1.1.0-beta.1', '1.1.0'],
    ['', '1.0.0'],
    ['latest', '1.0.0'],
    ['1.2', '1.0.0'],
    ['1.2.0', 'garbage'],
  ])('%s is not newer than %s', (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(false);
  });
});

describe('desktopAppVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null in a browser', () => {
    vi.stubGlobal('window', {});
    expect(desktopAppVersion()).toBeNull();
  });

  it('reads the version the shell injected', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __CAMPUSNOTEHUB_DESKTOP__: { version: '1.1.0' } });
    expect(desktopAppVersion()).toBe('1.1.0');
  });

  it('treats a Tauri host that reports nothing as a legacy build', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(desktopAppVersion()).toBe(LEGACY_DESKTOP_VERSION);
  });
});
