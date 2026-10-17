import { truncate } from '../screen.js';

/**
 * The cosmodrome mark: cosmo is the star, the agent is the satellite orbiting it.
 * Medium (3 lines) when there is room, one line on narrow terminals and after /clear.
 */
export function header({ version, cwd, cols, t, glyphs = { star: '✦', sat: '◉' }, compact = false }) {
  const star = t.magenta(t.bold(glyphs.star));
  const sat = t.cyan(t.bold(glyphs.sat));
  const o = t.dim;
  const name = `${t.bold('cosmodrome')} ${t.dim(`v${version}`)}`;
  const fit = (s) => truncate(s, cols - 1);
  if (compact || cols < 60) {
    return [fit(`${o('-(')}${star}${o(')-')}${sat}  ${name} ${t.dim(`· ${cwd}`)}`), ''];
  }
  return [
    fit(o("  .-'''''-.")),
    fit(`${o(".'    ")}${star}${o("    '.")}${sat}    ${name}`),
    fit(`${o(" '-._____.-'")}      ${t.dim(cwd)}`),
    fit(t.dim('/ commands · # channel · @ other agent · ! shell · ? keys')),
    '',
  ];
}
