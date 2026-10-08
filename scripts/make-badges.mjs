/**
 * Regenerate the README badge row.
 *
 * The badges are committed SVG rather than shields.io URLs. Two reasons: the
 * repository is aimed at readers for whom img.shields.io and GitHub's camo proxy
 * are both unreliable, and a plugin whose whole pitch is "zero dependencies,
 * zero cost" should not need somebody else's server to render its own README.
 *
 * Badge text is English and deliberately carries no counts: a hard-coded "65
 * tests" starts lying the next time a test is added. Say what runs them, not how
 * many there were on the day this was written.
 *
 * Usage: node scripts/make-badges.mjs
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'badges');

/** Label background, matching the conventional badge look. */
const LABEL_FILL = '#555';

/**
 * Per-character advance widths for Verdana at 11px, near enough for a badge.
 *
 * SVG cannot measure text, so the box has to be computed. Guessing one average
 * width per character is what makes a badge clip its own label; guessing low is
 * what makes it clip when the viewer falls back to a wider face, so these sit
 * slightly above Verdana's real metrics.
 */
function charWidth(character) {
  if (character === ' ') return 4.6;
  if ("ilj|.,:;!'`()[]{}/".includes(character)) return 4.6;
  if ('mwMW@%'.includes(character)) return 11;
  if (character >= 'A' && character <= 'Z') return 9;
  if (character >= '0' && character <= '9') return 7.3;
  if (character === '>' || character === '<' || character === '=') return 8.2;
  return 7.2;
}

const textWidth = (text) => [...text].reduce((total, character) => total + charWidth(character), 0);

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One flat badge: label half, value half, two centred runs of text. */
function badge(label, value, color) {
  const padding = 8;
  const labelWidth = Math.round(textWidth(label) + padding * 2);
  const valueWidth = Math.round(textWidth(value) + padding * 2);
  const total = labelWidth + valueWidth;
  const aria = `${label}: ${value}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escape(aria)}">
  <title>${escape(aria)}</title>
  <rect width="${total}" height="20" rx="3" fill="${LABEL_FILL}"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="20" rx="3" fill="${color}"/>
  <rect x="${labelWidth - 3}" width="6" height="20" fill="${color}"/>
  <g fill="#ffffff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${escape(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${escape(value)}</text>
  </g>
</svg>
`;
}

// The palette echoes the plugin's own schedule band, so the badge row looks like
// it belongs to the product rather than to a template.
//
// The test badge is deliberately absent: it is GitHub's own workflow badge, which
// reports whether the suite passes right now rather than what command runs it. A
// status is always true; a description of a command is not a reason to trust the
// repository, and a count would go stale.
const BADGES = {
  node: badge('node', '>=22', '#339933'),
  platform: badge('platform', 'DeepSeek Harness', '#4D6BFE'),
  dependencies: badge('dependencies', 'none', '#2f9e6b'),
  cost: badge('off-duty cost', '0 tokens', '#d6a93b'),
  license: badge('license', 'MIT', '#97ca00'),
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(BADGES)) {
  const file = join(OUT_DIR, `${name}.svg`);
  writeFileSync(file, svg);
  console.log(`wrote badges/${name}.svg  (${svg.length} bytes)`);
}

// Drop anything no longer declared. Without this the directory accumulates every
// badge ever written, and the CI check -- which only compares files the generator
// touches -- would let a retired badge sit there looking current.
for (const entry of readdirSync(OUT_DIR)) {
  if (!entry.endsWith('.svg')) continue;
  if (Object.hasOwn(BADGES, entry.slice(0, -'.svg'.length))) continue;
  rmSync(join(OUT_DIR, entry));
  console.log(`removed badges/${entry}`);
}
