import 'server-only';
import { unstable_cache } from 'next/cache';

/**
 * Where "Download for Windows" points.
 *
 * The installer is built by .github/workflows/desktop-windows.yml and attached
 * to a GitHub Release when a `desktop-vX.Y.Z` tag is pushed. Tauri puts the
 * version in the file name (campusnotehub_1.0.0_x64-setup.exe), so there is no
 * fixed URL to hard-code: /releases/latest/download/<name> breaks on every
 * version bump. The newest desktop release is looked up through the GitHub API
 * instead, which also answers "is there anything to download yet?" - a
 * hard-coded link cannot, and before the first tag it would be a 404 behind
 * the most prominent button on the site.
 *
 * WINDOWS_INSTALLER_URL overrides the lookup, for hosting the file elsewhere:
 * an https URL, or a root-relative path to a file under public/. Anything else
 * (a leftover "#", "TODO", an http:// link) is ignored with a warning rather
 * than rendered as a broken download.
 */

export type WindowsInstaller = {
  url: string;
  /** "1.0.0". Null when the URL comes from WINDOWS_INSTALLER_URL. */
  version: string | null;
  sizeBytes: number | null;
};

const RELEASES_REPO = 'Mammad-Hamidli/campusnotehub';
const TAG_PREFIX = 'desktop-v';
const INSTALLER_ASSET = /-setup\.exe$/i;

export type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size: number }[];
};

/**
 * The installer of the newest desktop release, from GitHub's newest-first
 * release list. The repo may carry other kinds of releases later, and a
 * desktop release whose upload failed has no installer, so both are skipped
 * rather than trusting /releases/latest.
 */
export function pickWindowsInstaller(releases: GitHubRelease[]): WindowsInstaller | null {
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith(TAG_PREFIX)) continue;
    const asset = release.assets.find((a) => INSTALLER_ASSET.test(a.name));
    if (asset) {
      return {
        url: asset.browser_download_url,
        version: release.tag_name.slice(TAG_PREFIX.length),
        sizeBytes: asset.size,
      };
    }
  }
  return null;
}

function configuredInstallerUrl(): string | null {
  const raw = process.env.WINDOWS_INSTALLER_URL?.trim();
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.href;
  } catch {
    // Not a URL: fall through to the warning.
  }
  console.warn('[desktop] WINDOWS_INSTALLER_URL is not an https URL or a root-relative path; ignoring it');
  return null;
}

/**
 * Cached for 10 minutes across all visitors, so the landing page costs at most
 * a handful of unauthenticated GitHub API calls an hour (the limit is 60 per
 * IP). A failed call THROWS, which unstable_cache never stores: once a release
 * has been seen, a GitHub outage or rate limit keeps serving it (stale while
 * revalidate) instead of hiding the button. "No desktop release yet" is a real
 * answer and is cached like any other.
 */
const latestGitHubInstaller = unstable_cache(
  async (): Promise<WindowsInstaller | null> => {
    const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'campusnotehub',
      },
      // The landing page awaits this on a cold cache; GitHub being slow must
      // not make the page slow.
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`);
    return pickWindowsInstaller((await response.json()) as GitHubRelease[]);
  },
  ['windows-installer'],
  { revalidate: 600 },
);

/** The current Windows installer, or null when there is nothing to download. */
export async function getWindowsInstaller(): Promise<WindowsInstaller | null> {
  const configured = configuredInstallerUrl();
  if (configured) return { url: configured, version: null, sizeBytes: null };

  try {
    return await latestGitHubInstaller();
  } catch (error) {
    console.error('[desktop] installer lookup failed', error);
    return null;
  }
}
