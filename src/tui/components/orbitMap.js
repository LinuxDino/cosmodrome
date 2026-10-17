import { width } from '../screen.js';

const SLOTS = 3;

/**
 * A profile as a small solar system: the star is the profile, each installed agent is a
 * satellite (◉ the current channel, ✧ the others). Up to three satellites are drawn;
 * more installed agents and missing ones are listed underneath.
 *
 *              ◉ claude
 *         .'''      '''.
 *     ✦  work            ✧ copilot
 *         '...      ...'
 *              ✧ codex
 */
export function orbitMap({ profile, agents, missing = [], t, glyphs = { star: '✦', sat: '◉', idle: '✧' } }) {
  const o = t.dim;
  const sat = (a) => {
    const mark = a.current ? t.cyan(t.bold(glyphs.sat)) : o(glyphs.idle || '+');
    const name = a.current ? t.bold(a.name) : a.name;
    return `${mark} ${name}${a.isDefault ? o(' (default)') : ''}`;
  };
  const [top, right, bottom] = agents.slice(0, SLOTS);
  const label = t.magenta(t.bold(profile));
  // The right satellite sits after the profile name, at least where the orbit ends.
  const gap = ' '.repeat(Math.max(2, 16 - width(profile)));
  const lines = [
    top ? `             ${sat(top)}` : '',
    `        ${o(".'''      '''.")}`,
    `    ${t.magenta(t.bold(glyphs.star))}  ${label}${right ? gap + sat(right) : ''}`,
    `        ${o("'...      ...'")}`,
  ];
  if (bottom) lines.push(`             ${sat(bottom)}`);
  const extra = agents.slice(SLOTS);
  if (extra.length) lines.push(`    ${o('also:')} ${extra.map(sat).join(o(' · '))}`);
  if (missing.length) lines.push(`    ${o(`not installed: ${missing.join(', ')}`)}`);
  return lines;
}
