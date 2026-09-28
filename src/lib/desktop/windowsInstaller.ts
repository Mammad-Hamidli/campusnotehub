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

const GITHUB_TIMEOUT_MS = 5000;

async function fetchLatestGitHubInstaller(): Promise<WindowsInstaller | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'campusnotehub',
  };
  // Optional. Unauthenticated calls share 60 an hour per IP with everything
  // else on a serverless egress IP; a token gets 5,000. A fine-grained token
  // with no permissions is enough to read a public repo's releases.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`, {
    headers,
    // The landing page awaits this on a cold cache; GitHub being slow must
    // not make the page slow. The signal also bounds reading the body.
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return pickWindowsInstaller((await response.json()) as GitHubRelease[]);
}

/** GitHub's last answer to this server process; undefined until it gives one. */
let lastKnownInstaller: WindowsInstaller | null | undefined;

/**
 * Cached for 10 minutes across all visitors, so the landing page costs at most
 * a handful of GitHub API calls an hour. A failure must not be cached as
 * "nothing to download" - that would hide the button for 10 minutes over one
 * slow response - so:
 *  - once this process has seen an answer, a failure (timeout, rate limit,
 *    outage) re-serves that answer instead;
 *  - before that, it THROWS, which unstable_cache never stores, and
 *    getWindowsInstaller falls back to null for this request only.
 * "No desktop release yet" is a real answer and is cached like any other.
 */
const latestGitHubInstaller = unstable_cache(
  async (): Promise<WindowsInstaller | null> => {
    try {
      lastKnownInstaller = await fetchLatestGitHubInstaller();
      return lastKnownInstaller;
    } catch (error) {
      if (lastKnownInstaller !== undefined) return lastKnownInstaller;
      throw error;
    }
  },
  ['windows-installer'],
  { revalidate: 600 },
);

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no answer within ${GITHUB_TIMEOUT_MS} ms`;
  return error instanceof Error ? error.message : String(error);
}

/** The current Windows installer, or null when there is nothing to download. */
export async function getWindowsInstaller(): Promise<WindowsInstaller | null> {
  const configured = configuredInstallerUrl();
  if (configured) return { url: configured, version: null, sizeBytes: null };

  try {
    return await latestGitHubInstaller();
  } catch (error) {
    // Expected and handled (the button says "coming soon"), so a one-line
    // warning: console.error would surface in the Next dev overlay as if the
    // page had crashed.
    console.warn(`[desktop] GitHub releases lookup failed (${describeFailure(error)}); hiding the download`);
    return null;
  }
}
