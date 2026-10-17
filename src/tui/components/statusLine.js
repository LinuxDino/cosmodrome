import { width, truncate } from '../screen.js';

/** "~/work/clients/acme/api" -> "~/work/…/api" so the end of the path stays readable. */
export function shortenPath(p, max) {
  if (width(p) <= max) return p;
  const parts = p.split('/');
  const last = parts.pop();
  let head = parts.shift() ?? '';
  while (parts.length && width(`${head}/${parts[0]}/…/${last}`) <= max) head += `/${parts.shift()}`;
  const out = `${head}/…/${last}`;
  return width(out) <= max ? out : truncate(last, max);
}

/**
 * Footer under the input: channel, mode, account, folder - plus module items.
 * Narrow terminals drop the least important parts first: 80+ everything, 60+ no GitHub
 * user, below 60 a short mode and no key hints.
 */
export function statusLine({ channel, mode, ghUser, cwd, notice, items = [], t, cols = 100 }) {
  if (notice) return [`  ${t.yellow(notice)}`];
  const narrow = cols < 60;
  const parts = [
    channel ? t.magenta(t.bold(`#${channel}`)) : t.yellow('no channel - /init'),
    mode === 'auto' ? t.yellow(narrow ? '⏵⏵ auto' : '⏵⏵ auto mode') : t.dim(narrow ? 'ask' : 'ask mode'),
    ghUser && cols >= 80 ? t.dim(`GitHub ${ghUser}`) : null,
    ...items.map((s) => t.dim(s)),
  ].filter(Boolean);
  const used = width(`  ${parts.join(' · ')} · `);
  if (cols - 1 - used >= 8) parts.splice(cols >= 80 && ghUser ? 3 : 2, 0, t.dim(shortenPath(cwd, cols - 1 - used)));
  const lines = [`  ${parts.join(t.dim(' · '))}`];
  if (!narrow) lines.push(t.dim('  shift+tab mode · ctrl+o next agent · ? shortcuts'));
  return lines;
}
