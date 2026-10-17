import { pad } from '../screen.js';

/** Welcome box shown when cosmo starts. */
export function header({ version, cwd, cols, t }) {
  const w = Math.max(24, Math.min(cols - 1, 66));
  const inner = w - 4;
  const row = (s = '') => `${t.magenta('│')} ${pad(s, inner)} ${t.magenta('│')}`;
  return [
    t.magenta('╭' + '─'.repeat(w - 2) + '╮'),
    row(`${t.magenta('✦')} Welcome to ${t.bold('cosmodrome')} ${t.dim(`v${version}`)}`),
    row(),
    row(t.dim('/ commands · # channel · @ other agent · ! shell')),
    row(),
    row(t.dim(`cwd: ${cwd}`)),
    t.magenta('╰' + '─'.repeat(w - 2) + '╯'),
  ];
}
