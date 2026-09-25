import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// No Next incremental cache outside a request: call straight through.
vi.mock('next/cache', () => ({ unstable_cache: <T>(fn: T) => fn }));

import { getWindowsInstaller, pickWindowsInstaller, type GitHubRelease } from './windowsInstaller';

function release(tag: string, assets: string[], extra: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
      size: 5_347_328,
    })),
    ...extra,
  };
}

describe('pickWindowsInstaller', () => {
  it('takes the setup exe of the newest desktop release', () => {
    expect(
      pickWindowsInstaller([
        release('desktop-v1.1.0', ['campusnotehub_1.1.0_x64-setup.exe']),
        release('desktop-v1.0.0', ['campusnotehub_1.0.0_x64-setup.exe']),
      ]),
    ).toEqual({
      url: 'https://github.com/o/r/releases/download/desktop-v1.1.0/campusnotehub_1.1.0_x64-setup.exe',
      version: '1.1.0',
      sizeBytes: 5_347_328,
    });
  });

  it('skips prereleases, drafts, other tags and releases without an installer', () => {
    expect(
      pickWindowsInstaller([
        release('web-v2.0.0', ['campusnotehub_2.0.0_x64-setup.exe']),
        release('desktop-v1.3.0', ['campusnotehub_1.3.0_x64-setup.exe'], { prerelease: true }),
        release('desktop-v1.2.0', ['campusnotehub_1.2.0_x64-setup.exe'], { draft: true }),
        release('desktop-v1.1.0', ['notes.txt']),
        release('desktop-v1.0.0', ['campusnotehub_1.0.0_x64-setup.exe']),
      ])?.version,
    ).toBe('1.0.0');
  });

  it('is null when there is no desktop release', () => {
    expect(pickWindowsInstaller([])).toBeNull();
    expect(pickWindowsInstaller([release('desktop-v1.0.0', [])])).toBeNull();
  });
});

describe('getWindowsInstaller', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it.each(['https://cdn.example.com/campusnotehub-setup.exe', '/downloads/campusnotehub-setup.exe'])(
    'uses WINDOWS_INSTALLER_URL=%s without asking GitHub',
    async (url) => {
      vi.stubEnv('WINDOWS_INSTALLER_URL', url);
      expect(await getWindowsInstaller()).toEqual({ url, version: null, sizeBytes: null });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['#', 'TODO', 'http://example.com/setup.exe', '//example.com/setup.exe', '   '])(
    'ignores the placeholder WINDOWS_INSTALLER_URL=%j and falls back to GitHub',
    async (url) => {
      vi.stubEnv('WINDOWS_INSTALLER_URL', url);
      fetchMock.mockResolvedValue(
        Response.json([release('desktop-v1.0.0', ['campusnotehub_1.0.0_x64-setup.exe'])]),
      );
      expect((await getWindowsInstaller())?.version).toBe('1.0.0');
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('is null when GitHub fails', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 403 }));
    expect(await getWindowsInstaller()).toBeNull();
  });
});
