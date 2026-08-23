import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultSourcePath(url: string, rootDir: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }

  if (url.startsWith('/') && !url.startsWith('//')) {
    return containedIn(rootDir, path.resolve(rootDir, url.slice(1)));
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname && pathname !== '/') {
        return containedIn(rootDir, path.resolve(rootDir, pathname.replace(/^\//, '')));
      }
    }
  } catch {
    // not a valid URL
  }

  return null;
}

/**
 * The default URL→path heuristic must never map outside rootDir: an encoded
 * `..%2f` in a URL path would otherwise let a report entry target arbitrary
 * writable files. A user-supplied sourcePath() can still map anywhere.
 */
function containedIn(rootDir: string, resolved: string): string | null {
  const rel = path.relative(path.resolve(rootDir), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

export function contentMatchesDisk(coverageSource: string, diskContent: string): boolean {
  if (coverageSource === diskContent) return true;
  // Allow trailing newline differences
  const normCoverage = coverageSource.replace(/\r\n/g, '\n');
  const normDisk = diskContent.replace(/\r\n/g, '\n');
  return normCoverage === normDisk;
}
