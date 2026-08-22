import { describe, expect, it } from 'vitest';
import { pruneCss } from './css.js';

/**
 * Ranges in these tests mimic what Chrome CSS coverage actually reports
 * (verified against live chromium via playwright, 2026-08-22):
 *  - a used style rule -> ONE range spanning the full rule, selector
 *    through closing `}`;
 *  - a used @media/@supports -> a range covering ONLY the condition text
 *    (after the at-keyword, up to but not including `{`, trailing space
 *    included), plus separate full-span ranges for used inner rules;
 *  - @keyframes, @font-face and @import -> never reported at all;
 *  - unused rules and fully-unmatched @media -> nothing, not even the prelude.
 */
function rangeOf(source: string, snippet: string): { start: number; end: number } {
  const start = source.indexOf(snippet);
  if (start === -1) throw new Error(`snippet not found: ${snippet}`);
  if (source.indexOf(snippet, start + 1) !== -1) {
    throw new Error(`snippet is not unique: ${snippet}`);
  }
  return { start, end: start + snippet.length };
}

function rangesOf(source: string, snippets: string[]): { start: number; end: number }[] {
  return snippets.map((s) => rangeOf(source, s));
}

describe('pruneCss', () => {
  it('returns source unchanged for empty usedRanges', () => {
    const source = '.a { color: red; }\n.b { color: blue; }\n';
    expect(pruneCss(source, [])).toBe(source);
  });

  it('returns source unchanged when all ranges are zero-length', () => {
    const source = '.a { color: red; }\n.b { color: blue; }\n';
    expect(pruneCss(source, [{ start: 3, end: 3 }, { start: 10, end: 10 }])).toBe(source);
  });

  it('keeps used rules byte-identical and drops unused simple rules', () => {
    const source = [
      'body { color: black; }',
      '',
      '.unused { color: red; }',
      '',
      '.also-used   ,  .odd-formatting{color:green}',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, [
        'body { color: black; }',
        '.also-used   ,  .odd-formatting{color:green}',
      ]),
    );
    expect(out).toContain('body { color: black; }');
    expect(out).toContain('.also-used   ,  .odd-formatting{color:green}');
    expect(out).not.toContain('.unused');
  });

  it('partially-used @media keeps the wrapper and used inner rule, drops the unused one', () => {
    const source = [
      '@media (min-width: 100px) {',
      '  .used { color: black; }',
      '  .unused { color: blue; }',
      '}',
      '',
    ].join('\n');
    // Chrome reports the condition text and the used inner rule, NOT the
    // @media keyword or the braces.
    const out = pruneCss(
      source,
      rangesOf(source, ['(min-width: 100px) ', '.used { color: black; }']),
    );
    expect(out).toBe(
      ['@media (min-width: 100px) {', '  .used { color: black; }', '}', ''].join('\n'),
    );
  });

  it('drops a fully-unused @media entirely', () => {
    const source = [
      '.kept { color: black; }',
      '@media (min-width: 99999px) {',
      '  .never { color: purple; }',
      '}',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.kept { color: black; }']));
    expect(out).not.toContain('@media');
    expect(out).not.toContain('.never');
    expect(out).toContain('.kept { color: black; }');
  });

  it('keeps a fully-used group byte-identical', () => {
    const block = [
      '@media (min-width: 10px) {',
      '  .a { color: red; }',
      '  .b { color: blue; }',
      '}',
    ].join('\n');
    const source = `${block}\n`;
    const out = pruneCss(
      source,
      rangesOf(source, ['(min-width: 10px) ', '.a { color: red; }', '.b { color: blue; }']),
    );
    expect(out).toContain(block);
  });

  it('always keeps @keyframes and @font-face (Chrome never reports them)', () => {
    const source = [
      '@keyframes spin {',
      '  from { transform: rotate(0deg); }',
      '  to { transform: rotate(360deg); }',
      '}',
      '',
      '@font-face {',
      '  font-family: "MyFont";',
      '  src: url("data:font/woff2;base64,AAAA") format("woff2");',
      '}',
      '',
      '.spinner { animation: spin 1s linear infinite; }',
      '',
      '.unused { color: red; }',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, ['.spinner { animation: spin 1s linear infinite; }']),
    );
    expect(out).toContain('@keyframes spin {');
    expect(out).toContain('to { transform: rotate(360deg); }');
    expect(out).toContain('@font-face {');
    expect(out).toContain('font-family: "MyFont";');
    expect(out).toContain('.spinner');
    expect(out).not.toContain('.unused');
  });

  it('handles nested @media inside @supports with condition-only coverage', () => {
    const source = [
      '@supports (display: flex) {',
      '  @media (min-width: 50px) {',
      '    .nested-used { display: flex; }',
      '    .nested-unused { display: grid; }',
      '  }',
      '}',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, [
        '(display: flex) ',
        '(min-width: 50px) ',
        '.nested-used { display: flex; }',
      ]),
    );
    expect(out).toBe(
      [
        '@supports (display: flex) {',
        '  @media (min-width: 50px) {',
        '    .nested-used { display: flex; }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('drops a group whose only kept content would be nothing, even when nested', () => {
    const source = [
      '.kept { color: black; }',
      '@supports (display: grid) {',
      '  @media (min-width: 100px) {',
      '    .never { color: red; }',
      '  }',
      '}',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.kept { color: black; }']));
    expect(out).not.toContain('@supports');
    expect(out).not.toContain('@media');
    expect(out).not.toContain('.never');
  });

  it('is not confused by strings containing braces', () => {
    const source = [
      '.a::before { content: "}"; }',
      ".b::after { content: '{'; }",
      '.x[data-v="{"] { color: green; }',
      '.dropped { color: red; }',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, [
        '.a::before { content: "}"; }',
        '.x[data-v="{"] { color: green; }',
      ]),
    );
    expect(out).toContain('.a::before { content: "}"; }');
    expect(out).toContain('.x[data-v="{"] { color: green; }');
    expect(out).not.toContain('.b::after');
    expect(out).not.toContain('.dropped');
  });

  it('is not confused by unquoted url() with special characters', () => {
    const source = [
      '@import url(data:text/css;base64,AAaa+/==);',
      '.kept { background: url(data:image/svg+xml;charset=utf-8,<svg}{;></svg>); }',
      '.dropped { background: url(data:image/png;base64,iVBOR{w0}KGgo=); }',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, [
        '.kept { background: url(data:image/svg+xml;charset=utf-8,<svg}{;></svg>); }',
      ]),
    );
    // The `;` inside the unquoted url must not terminate the @import statement.
    expect(out).toContain('@import url(data:text/css;base64,AAaa+/==);');
    expect(out).toContain(
      '.kept { background: url(data:image/svg+xml;charset=utf-8,<svg}{;></svg>); }',
    );
    expect(out).not.toContain('.dropped');
  });

  it('is not confused by comments containing braces', () => {
    const source = [
      '/* { this is not a rule } */',
      '.kept { /* } sneaky closer { */ color: green; }',
      '/* } */ .dropped { color: red; } /* { */',
      '',
    ].join('\n');
    const out = pruneCss(
      source,
      rangesOf(source, ['.kept { /* } sneaky closer { */ color: green; }']),
    );
    expect(out).toContain('.kept { /* } sneaky closer { */ color: green; }');
    expect(out).not.toContain('.dropped');
  });

  it('safelist keeps :hover rules and @media print regardless of coverage', () => {
    const source = [
      '.used { color: black; }',
      '.btn:hover { color: red; }',
      '@media print {',
      '  .print-only { display: none; }',
      '}',
      '.gone { color: blue; }',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']), {
      safelist: [':hover$', '^@media print$'],
    });
    expect(out).toContain('.used { color: black; }');
    expect(out).toContain('.btn:hover { color: red; }');
    // Safelisted group keeps its whole block.
    expect(out).toContain('@media print {\n  .print-only { display: none; }\n}');
    expect(out).not.toContain('.gone');
  });

  it('ignores invalid safelist patterns instead of failing', () => {
    const source = '.used { color: black; }\n.gone { color: blue; }\n';
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']), {
      safelist: ['(unclosed', '\\.gone'],
    });
    expect(out).toContain('.used');
    expect(out).toContain('.gone');
  });

  it('always keeps statement at-rules', () => {
    const source = [
      '@charset "utf-8";',
      '@import url("reset.css") screen;',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@layer base, components;',
      '.used { color: black; }',
      '.gone { color: blue; }',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']));
    expect(out).toContain('@charset "utf-8";');
    expect(out).toContain('@import url("reset.css") screen;');
    expect(out).toContain('@namespace svg url(http://www.w3.org/2000/svg);');
    expect(out).toContain('@layer base, components;');
    expect(out).not.toContain('.gone');
  });

  it('always keeps @page, @property, @counter-style and @font-feature-values', () => {
    const source = [
      '@page :first { margin: 1in; }',
      '@property --hue { syntax: "<number>"; inherits: false; initial-value: 0; }',
      '@counter-style thumbs { system: cyclic; symbols: "x"; }',
      '@font-feature-values Font One { @styleset { nice-style: 12; } }',
      '.used { color: black; }',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']));
    expect(out).toContain('@page :first { margin: 1in; }');
    expect(out).toContain('@property --hue');
    expect(out).toContain('@counter-style thumbs');
    expect(out).toContain('@font-feature-values Font One { @styleset { nice-style: 12; } }');
  });

  it('treats unknown block at-rules with nested rules as groups', () => {
    const source = [
      '@unknown-wrap (something) {',
      '  .a { color: red; }',
      '  .b { color: blue; }',
      '}',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.a { color: red; }']));
    expect(out).toContain('@unknown-wrap (something) {');
    expect(out).toContain('.a { color: red; }');
    expect(out).not.toContain('.b');
  });

  it('keeps unknown block at-rules with declaration bodies as opaque leaves', () => {
    const source = [
      '@weird-leaf { some: declaration; other: thing; }',
      '.used { color: black; }',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']));
    expect(out).toContain('@weird-leaf { some: declaration; other: thing; }');
  });

  it('keeps a @media wrapper whose only surviving child is a leaf at-rule', () => {
    const source = [
      '@media (min-width: 600px) {',
      '  @keyframes slide { from { left: 0; } to { left: 100px; } }',
      '  .never { color: red; }',
      '}',
      '.used { color: black; }',
      '',
    ].join('\n');
    const out = pruneCss(source, rangesOf(source, ['.used { color: black; }']));
    expect(out).toContain('@media (min-width: 600px) {');
    expect(out).toContain('@keyframes slide');
    expect(out).not.toContain('.never');
  });

  it('returns malformed CSS unchanged', () => {
    const unclosed = 'body { color: red;';
    expect(pruneCss(unclosed, [{ start: 0, end: 5 }])).toBe(unclosed);

    const strayBrace = '} body { color: red; }';
    expect(pruneCss(strayBrace, [{ start: 0, end: 5 }])).toBe(strayBrace);

    const declarationAtTop = 'color: red;\nbody { color: blue; }';
    expect(pruneCss(declarationAtTop, [{ start: 0, end: 5 }])).toBe(declarationAtTop);
  });

  it('prunes the calibration stylesheet with the exact ranges Chrome reported', () => {
    // The stylesheet and used snippets below reproduce the live calibration
    // run byte for byte (see the comment at the top of css.ts).
    const source = `body { color: rgb(1, 2, 3); }

.unused { color: red; }

@media (min-width: 100px) {
  .used-in-media { color: rgb(4, 5, 6); }
  .unused-in-media { color: blue; }
}

@media (min-width: 99999px) {
  .never { color: purple; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinner { animation: spin 1s linear infinite; }

.btn:hover { outline: 1px solid rgb(7, 8, 9); }

.nohover:hover { outline: 2px solid green; }

@font-face {
  font-family: "CalFont";
  src: url("data:font/woff2;base64,AAAA") format("woff2");
}

.uses-font { font-family: "CalFont", sans-serif; }

@supports (display: flex) {
  @media (min-width: 50px) {
    .nested-used { display: flex; }
    .nested-unused { display: grid; }
  }
}

@import url("noop.css");
`;
    const used = rangesOf(source, [
      'body { color: rgb(1, 2, 3); }',
      '(min-width: 100px) ',
      '.used-in-media { color: rgb(4, 5, 6); }',
      '.spinner { animation: spin 1s linear infinite; }',
      '.btn:hover { outline: 1px solid rgb(7, 8, 9); }',
      '.uses-font { font-family: "CalFont", sans-serif; }',
      '(display: flex) ',
      '(min-width: 50px) ',
      '.nested-used { display: flex; }',
    ]);
    const out = pruneCss(source, used);

    // Used rules survive byte-identical.
    expect(out).toContain('body { color: rgb(1, 2, 3); }');
    expect(out).toContain('.used-in-media { color: rgb(4, 5, 6); }');
    expect(out).toContain('.spinner { animation: spin 1s linear infinite; }');
    expect(out).toContain('.btn:hover { outline: 1px solid rgb(7, 8, 9); }');
    expect(out).toContain('.nested-used { display: flex; }');
    // Wrappers are preserved as valid structure, not condition fragments.
    expect(out).toContain('@media (min-width: 100px) {');
    expect(out).toContain('@supports (display: flex) {');
    expect(out).toContain('@media (min-width: 50px) {');
    // Constructs coverage cannot see survive.
    expect(out).toContain('@keyframes spin {');
    expect(out).toContain('@font-face {');
    expect(out).toContain('@import url("noop.css");');
    // Unused content is gone.
    expect(out).not.toContain('.unused');
    expect(out).not.toContain('@media (min-width: 99999px)');
    expect(out).not.toContain('.never');
    expect(out).not.toContain('.nohover');
    expect(out).not.toContain('.nested-unused');
    // Structure stays balanced.
    const opens = (out.match(/\{/g) ?? []).length;
    const closes = (out.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
