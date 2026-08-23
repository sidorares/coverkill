import picomatch from 'picomatch';
import path from 'node:path';

const DEBUG_GLOBS =
  process.env.COVERKILL_DEBUG_GLOBS === '1' ||
  process.env.COVERKILL_DEBUG_GLOBS === 'true';

function logGlobs(message: string, data?: Record<string, unknown>) {
  if (!DEBUG_GLOBS) return;
  if (data) {
    console.error(`[coverkill:globs] ${message}`, data);
  } else {
    console.error(`[coverkill:globs] ${message}`);
  }
}

function matchByPattern(
  patterns: string[],
  rel: string,
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const pattern of patterns) {
    if (picomatch(pattern, { dot: true })(rel)) {
      matched.push(pattern);
    } else {
      unmatched.push(pattern);
    }
  }
  return { matched, unmatched };
}

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

  const includePatterns = include && include.length > 0 ? include : [];
  const excludePatterns = exclude && exclude.length > 0 ? exclude : [];

  const includeMatcher =
    includePatterns.length > 0 ? picomatch(includePatterns, { dot: true }) : () => true;

  const excludeMatcher =
    excludePatterns.length > 0 ? picomatch(excludePatterns, { dot: true }) : () => false;

  logGlobs('createMatchers', {
    rootDir,
    include: includePatterns,
    exclude: excludePatterns,
    hasIncludeAllowlist: includePatterns.length > 0,
  });

  return {
    isIncluded(filePath: string) {
      const rel = relative(filePath);
      const excluded = excludeMatcher(rel);
      const excludeDetail =
        excludePatterns.length > 0 ? matchByPattern(excludePatterns, rel) : undefined;

      if (excluded) {
        logGlobs('isIncluded → false (excluded)', {
          filePath,
          rel,
          excluded: true,
          excludePatterns: excludeDetail,
        });
        return false;
      }

      if (includePatterns.length > 0) {
        const included = includeMatcher(rel);
        const includeDetail = matchByPattern(includePatterns, rel);
        logGlobs(included ? 'isIncluded → true' : 'isIncluded → false (not in include allowlist)', {
          filePath,
          rel,
          excluded: false,
          included,
          includePatterns: includeDetail,
        });
        return included;
      }

      logGlobs('isIncluded → true (no include allowlist)', {
        filePath,
        rel,
        excluded: false,
        included: true,
      });
      return true;
    },
  };
}
