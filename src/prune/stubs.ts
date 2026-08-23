/**
 * Loud stub modes (issue #6): every stub the pruner emits can announce that a
 * pruned path executed, instead of silently evaluating to `{}` / `0` /
 * `void 0`. The premise of pruning is unsound by construction — scenarios may
 * simply never have covered a reachable path — and a silent stub is the worst
 * way to find that out. `throw` turns such an execution into a hard error;
 * `beacon` reports it through a user-supplied global and then behaves like the
 * silent stub, so staging traffic can flag reachable-but-pruned paths without
 * breaking the page.
 *
 * The intended workflow: run a `throw`/`beacon` build in staging, watch for
 * announcements, then ship the `silent` build once nothing fires.
 */

export type PruneMode = 'silent' | 'throw' | 'beacon';

export const PRUNE_MODES = ['silent', 'throw', 'beacon'] as const;

/** Global the beacon mode calls (optional-chained, so absent is a no-op). */
export const BEACON_GLOBAL = '__coverkillPrunedPathHit';

/**
 * Produces the announcement text loud modes insert into stubs. Locations are
 * `label:line` with 1-based lines in the ORIGINAL source — the file the user
 * has in version control — so an announcement is greppable even though the
 * pruned output has shifted.
 */
export class StubAnnouncer {
  /** False in silent mode: every announcement accessor returns '' / null. */
  readonly loud: boolean;
  private readonly mode: PruneMode;
  private readonly label: string;
  private readonly lineStarts: number[] | null;

  constructor(source: string, mode: PruneMode = 'silent', label = 'unknown') {
    this.mode = mode;
    this.loud = mode !== 'silent';
    this.label = label;
    this.lineStarts = this.loud ? buildLineStarts(source) : null;
  }

  /** `label:line` for an offset into the original source. */
  location(offset: number): string {
    return `${this.label}:${lineOfOffset(this.lineStarts ?? [0], offset)}`;
  }

  /** A statement (with trailing `;`) announcing execution; '' when silent. */
  statement(offset: number): string {
    if (!this.loud) return '';
    if (this.mode === 'throw') {
      const message = `coverkill: pruned path executed (${this.location(offset)})`;
      return `throw new Error(${JSON.stringify(message)});`;
    }
    return `globalThis.${BEACON_GLOBAL}?.(${JSON.stringify(this.location(offset))});`;
  }

  /**
   * An expression that announces, then yields `fallback` (the silent stub
   * value, so beacon mode stays behavior-compatible with silent); null when
   * silent. Always parenthesized, so it is safe in any expression position.
   */
  expression(offset: number, fallback: string): string | null {
    if (!this.loud) return null;
    if (this.mode === 'throw') {
      const message = `coverkill: pruned path executed (${this.location(offset)})`;
      return `(() => { throw new Error(${JSON.stringify(message)}); })()`;
    }
    return `(globalThis.${BEACON_GLOBAL}?.(${JSON.stringify(this.location(offset))}), ${fallback})`;
  }
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
