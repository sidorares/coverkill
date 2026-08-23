import { createHash } from 'node:crypto';

export const SOURCE_HASH_PREFIX = 'sha256-';

/**
 * Hash the executed text so a report can vouch for an on-disk file without
 * embedding its source. Hashing the UTF-8 encoding of the string keeps the
 * value stable across platforms; the offsets themselves stay UTF-16.
 */
export function hashSource(source: string): string {
  return SOURCE_HASH_PREFIX + createHash('sha256').update(source, 'utf8').digest('hex');
}

export function sourceMatchesHash(source: string, hash: string): boolean {
  return hashSource(source) === hash;
}
