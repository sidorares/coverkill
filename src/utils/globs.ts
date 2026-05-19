import picomatch from 'picomatch';
import path from 'node:path';

export function createMatchers(
  rootDir: string,
  include?: string[],
  exclude?: string[],
): {
  isIncluded: (filePath: string) => boolean;
} {
  const relative = (filePath: string) => {
    const rel = path.relative(rootDir, filePath);
    return rel.split(path.sep).join('/');
  };

  const includeMatcher =
    include && include.length > 0
      ? picomatch(include, { dot: true })
      : () => true;

  const excludeMatcher =
    exclude && exclude.length > 0
      ? picomatch(exclude, { dot: true })
      : () => false;

  return {
    isIncluded(filePath: string) {
      const rel = relative(filePath);
      if (excludeMatcher(rel)) return false;
      if (include && include.length > 0) {
        return includeMatcher(rel);
      }
      return true;
    },
  };
}
