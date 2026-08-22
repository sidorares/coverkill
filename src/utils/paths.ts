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
    return path.resolve(rootDir, url.slice(1));
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname && pathname !== '/') {
        return path.resolve(rootDir, pathname.replace(/^\//, ''));
      }
    }
  } catch {
    // not a valid URL
  }

  return null;
}

export function contentMatchesDisk(coverageSource: string, diskContent: string): boolean {
  if (coverageSource === diskContent) return true;
  // Allow trailing newline differences
  const normCoverage = coverageSource.replace(/\r\n/g, '\n');
  const normDisk = diskContent.replace(/\r\n/g, '\n');
  return normCoverage === normDisk;
}
