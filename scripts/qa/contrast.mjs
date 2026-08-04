#!/usr/bin/env node
/**
 * Measures the contrast of the console's palette, in both themes.
 *
 * Written because "check the contrast in light mode" is not a thing anybody can
 * do by looking. A dark palette that reads well on slate-950 does not survive
 * being dropped onto white — and the failures are exactly the pairs nobody
 * inspects closely: faint secondary text, a status pip on a raised panel, an
 * accent border. Guessing at those produces a theme that looks fine to whoever
 * built it and is unreadable to somebody with a cheap monitor in daylight.
 *
 * Reads the tokens out of globals.css rather than taking a copy, so it measures
 * what actually ships. The dark values come from the @theme block; the light
 * ones from the [data-theme='light'] overrides, falling back to dark for any
 * token that block does not restate.
 *
 *   node scripts/qa/contrast.mjs           # report, exit 1 on failure
 *   node scripts/qa/contrast.mjs --all     # include passing pairs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, '..', '..', 'apps', 'web', 'src', 'app', 'globals.css');

/* ---------- colour maths ------------------------------------------------- */

/** OKLCH → linear sRGB, via OKLab. Björn Ottosson's matrices. */
function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * WCAG 2.x relative luminance.
 *
 * Computed from LINEAR rgb, so there is no gamma round trip to get wrong. The
 * channels are clamped rather than left out of gamut: a colour outside sRGB is
 * displayed clipped, and the number should describe what is displayed.
 */
function luminance([r, g, b]) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- reading the palette ------------------------------------------ */

const OKLCH = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/;

function parseBlock(css, startIndex) {
  const open = css.indexOf('{', startIndex);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const line of body.split('\n')) {
    const name = /--(color-[a-z0-9-]+)\s*:/.exec(line);
    const value = OKLCH.exec(line);
    if (name === null || value === null) continue;
    out[name[1]] = oklchToLinearRgb(Number(value[1]), Number(value[2]), Number(value[3]));
  }
  return out;
}

const css = readFileSync(CSS, 'utf8');
const dark = parseBlock(css, css.indexOf('@theme'));
const lightOverrides = parseBlock(css, css.indexOf(":root[data-theme='light']"));
const light = { ...dark, ...lightOverrides };

if (Object.keys(dark).length === 0) {
  console.error('No tokens found in @theme — has globals.css moved?');
  process.exit(2);
}

/* ---------- what gets measured ------------------------------------------- */

const SURFACES = ['color-surface', 'color-panel', 'color-panel-raised'];

/**
 * Minimum ratios.
 *
 * 4.5 for anything read as prose, 3.0 for large text and for non-text things
 * that still have to be distinguishable — a border, a status pip, the accent on
 * a button. `ink-faint` is held to 4.5 despite the name: it carries timestamps
 * and helper text, which people read.
 */
const TEXT_TOKENS = [
  ['color-ink', 4.5],
  ['color-ink-muted', 4.5],
  ['color-ink-faint', 4.5],
  ['color-state-failed', 4.5],
  ['color-state-changed', 4.5],
  ['color-state-unchanged', 4.5],
  ['color-state-pending', 4.5],
  ['color-state-unknown', 4.5],
  ['color-accent-interactive', 3.0],
];

/**
 * Tokens used as a FILL behind fixed-colour text, rather than as text on a
 * surface.
 *
 * A different shape from the loop above, which measures a foreground token over
 * every surface. A filled control brings its own background, so the pair is
 * fixed and whatever is underneath does not enter into it.
 *
 * `--color-critical` exists because this check has an answer: white on
 * state-failed is 3.72:1 in dark, so a filled danger button reusing the status
 * token would have shipped with a label nobody could read.
 */
const FILLED = [
  // [background token, foreground literal, label, minimum]
  ['color-critical', [1, 1, 1], 'white on color-critical (filled danger button)', 4.5],
];

/*
 * `color-line` and `color-line-soft` are deliberately NOT measured.
 *
 * They are panel dividers and card edges — decoration, not the only way to
 * identify a control. WCAG 1.4.11 applies to components whose boundary carries
 * the meaning, and holding a hairline rule to 3:1 would force a divider heavy
 * enough to fight the content it separates. Borders that DO carry state (a
 * focused input, an invalid field) use the accent and status tokens, which are
 * measured above.
 */

/**
 * Pairs that already failed before this tool existed.
 *
 * All dark, all pre-existing: the light theme was added under a constraint that
 * dark must render exactly as it did, so fixing these was out of scope for the
 * slice that first measured them. They are listed rather than excused — the
 * tool reports them every run and fails only on something NEW, so the debt is
 * visible without blocking work that did not create it.
 *
 * Owed to issue #72 slice 5, the light-mode audit, which is where changing dark
 * values is on the table. `ink-faint` and `state-unknown` are the same colour
 * and account for six of the eight.
 */
const BASELINE = new Set([
  'dark color-ink-faint on color-surface',
  'dark color-ink-faint on color-panel',
  'dark color-ink-faint on color-panel-raised',
  'dark color-state-failed on color-panel-raised',
  'dark color-state-changed on color-panel-raised',
  'dark color-state-unknown on color-surface',
  'dark color-state-unknown on color-panel',
  'dark color-state-unknown on color-panel-raised',
]);

const showAll = process.argv.includes('--all');
let failures = 0;
let known = 0;
const unseen = new Set(BASELINE);

for (const [themeName, palette] of [
  ['dark', dark],
  ['light', light],
]) {
  console.log(`\n${themeName.toUpperCase()}`);

  for (const [token, minimum] of TEXT_TOKENS) {
    for (const surface of SURFACES) {
      const fg = palette[token];
      const bg = palette[surface];
      if (fg === undefined || bg === undefined) continue;

      const ratio = contrast(fg, bg);
      const ok = ratio >= minimum;
      const key = `${themeName} ${token} on ${surface}`;
      const excused = !ok && BASELINE.has(key);

      if (excused) known += 1;
      else if (!ok) failures += 1;

      // ONLY when it was actually excused. Deleting on every evaluated pair
      // emptied this set unconditionally, so the stale-baseline check below
      // could never fire — it reported a clean run against a baseline that had
      // stopped describing anything.
      if (excused) unseen.delete(key);

      if (!ok || showAll) {
        const mark = ok ? 'ok  ' : excused ? 'known' : 'FAIL';
        console.log(
          `  ${mark} ${ratio.toFixed(2).padStart(5)}:1 ` +
            `(min ${minimum.toFixed(1)})  ${token} on ${surface}`,
        );
      }
    }
  }

  for (const [bgToken, fgRgb, label, minimum] of FILLED) {
    const bg = palette[bgToken];
    if (bg === undefined) continue;

    const ratio = contrast(fgRgb, bg);
    const ok = ratio >= minimum;
    const key = `${themeName} ${label}`;
    const excused = !ok && BASELINE.has(key);

    if (excused) known += 1;
    else if (!ok) failures += 1;
    if (excused) unseen.delete(key);

    if (!ok || showAll) {
      const mark = ok ? 'ok  ' : excused ? 'known' : 'FAIL';
      console.log(
        `  ${mark} ${ratio.toFixed(2).padStart(5)}:1 (min ${minimum.toFixed(1)})  ${label}`,
      );
    }
  }

  /*
   * The palette's one hard rule (issue #72 §2): the interactive accent and the
   * "this node changed" status must not be the same colour, or the status
   * vocabulary stops meaning anything. Checked as a real distance, not equality
   * — two colours a hair apart are the same colour to a reader.
   */
  const accent = palette['color-accent-interactive'];
  const changed = palette['color-state-changed'];
  const separation = contrast(accent, changed);
  const distinct = separation >= 1.1 || Math.abs(luminance(accent) - luminance(changed)) > 0.02;
  if (!distinct) {
    failures += 1;
    console.log('  FAIL accent-interactive is indistinguishable from state-changed');
  } else if (showAll) {
    console.log('  ok   accent-interactive is distinct from state-changed');
  }
}

/*
 * A baseline entry that no longer fails is a baseline entry that should be
 * deleted. Left in place it quietly excuses a pair that has since regressed
 * back, which is the failure mode every suppression list eventually has.
 */
const fixed = [...unseen].filter((key) => BASELINE.has(key));
if (fixed.length > 0) {
  console.log('\nBASELINE OUT OF DATE — these now pass and should be removed from BASELINE:');
  for (const key of fixed) console.log(`  ${key}`);
  failures += fixed.length;
}

console.log(
  failures === 0
    ? `\nAll measured pairs meet their minimum${known > 0 ? ` (${known} known, pre-existing)` : ''}.`
    : `\n${failures} new pair(s) below minimum.`,
);
process.exit(failures === 0 ? 0 : 1);
