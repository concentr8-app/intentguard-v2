// Tells the student when a newer Concentr8 is out. The app cannot replace itself yet (that needs a signed app),
// so it shows a notice with a direct download of the right file for this computer.

import type { UpdateInfo } from '../shared/types';
export type { UpdateInfo };

export const RELEASES_REPO = 'concentr8-app/concentr8';
const LATEST_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const DOWNLOAD_BASE = `https://github.com/${RELEASES_REPO}/releases/latest/download`;
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;

/** -1, 0 or 1 for clean x.y.z versions; anything else (like "development") counts as older than every release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) || []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 && y.length !== 3) return 0;
  if (x.length !== 3) return -1;
  if (y.length !== 3) return 1;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The file the release workflow builds for this computer (artifactName "Concentr8-${arch}.${ext}"). */
export function assetFor(platform: string, arch: string): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'Concentr8-arm64.dmg' : 'Concentr8-x64.dmg';
  if (platform === 'win32') return 'Concentr8-x64.exe';
  if (platform === 'linux') return 'Concentr8-x64.AppImage';
  return null;
}

/**
 * Asks GitHub for the newest release. Returns it only when it is newer than this app and has a file for this
 * computer; null otherwise, and on any error (offline, rate limit), so a failed check never bothers anyone.
 */
export async function checkForUpdate(
  current: string,
  platform: string,
  arch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (compareVersions(current, '0.0.0') <= 0) return null; // development builds do not nag
  try {
    const res = await fetchImpl(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Concentr8' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const rel = (await res.json()) as { tag_name?: string; assets?: { name?: string }[] };
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (compareVersions(version, current) <= 0) return null;
    const file = assetFor(platform, arch);
    const names = (rel.assets || []).map((a) => a.name);
    const url = file && names.includes(file) ? `${DOWNLOAD_BASE}/${file}` : RELEASES_PAGE;
    return { version, url };
  } catch {
    return null;
  }
}
