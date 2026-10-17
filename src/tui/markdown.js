/** Light, line-by-line markdown styling for agent answers in the terminal. */
export function createMarkdownState() {
  return { fence: null, lang: null };
}

function formatLink(txt, url, t) {
  const u = t.underline(txt);
  const linked = typeof t.link === 'function' ? t.link(u, url) : u;
  if (url.startsWith('file://')) return typeof t.cyan === 'function' ? t.cyan(linked) : linked;
  return `${linked} ${t.dim(`(${url})`)}`;
}

// Links go first: the color codes added by the other rules contain "[" and would confuse the link pattern.
function inline(s, t) {
  return s
    .replace(/\[([^\]]+)\]\(((?:https?|file):\/\/[^)\s]+)\)/g, (_, txt, url) => formatLink(txt, url, t))
    .replace(/`([^`]+)`/g, (_, c) => t.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => t.bold(b))
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, p, i) => p + t.italic(i));
}

export function renderMarkdownLine(line, state, t) {
  const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
  if (fence) {
    if (!state.fence) {
      state.fence = fence[1];
      const info = fence[2] || '';
      state.lang = info.split(/\s+/)[0]?.toLowerCase() || '';
      if (state.lang === 'preview') {
        const title = info.replace(/^preview\s*/i, '').trim() || 'Preview';
        return `${t.magenta('╭─')} ${t.bold(t.magenta(`✦ ${title}`))} ${t.magenta('─'.repeat(16))}`;
      }
      return t.dim(`┌─ ${info || 'code'}`);
    }
    if (fence[1][0] === state.fence[0] && !fence[2]) {
      const wasPreview = state.lang === 'preview';
      state.fence = null;
      state.lang = null;
      return wasPreview ? t.magenta(`╰${'─'.repeat(28)}`) : t.dim('└─');
    }
  }
  if (state.fence) {
    if (state.lang === 'preview') {
      return `${t.magenta('│')} ${inline(line, t)}`;
    }
    if (state.lang === 'diff' || state.lang === 'patch') {
      if (line.startsWith('+') && !line.startsWith('+++')) return `${t.dim('│')} ${(t.green || t.cyan)(line)}`;
      if (line.startsWith('-') && !line.startsWith('---')) return `${t.dim('│')} ${(t.red || t.cyan)(line)}`;
      if (line.startsWith('@@')) return `${t.dim('│')} ${t.magenta(line)}`;
    }
    return `${t.dim('│')} ${t.cyan(line)}`;
  }
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return t.bold(t.magenta(h[2]));
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}${t.magenta('•')} ${inline(bullet[2], t)}`;
  const num = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (num) return `${num[1]}${t.magenta(num[2] + '.')} ${inline(num[3], t)}`;
  if (/^\s*>\s?/.test(line)) return t.dim(`│ ${line.replace(/^\s*>\s?/, '')}`);
  if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) return t.dim('─'.repeat(30));
  return inline(line, t);
}

/**
 * Render a styled preview box for a file or artifact in the terminal.
 */
export function renderPreviewBox({ title, url = null, lines = [], t, maxLines = 30 }) {
  const headLabel = url && typeof t.link === 'function' ? t.link(t.bold(title), url) : t.bold(title);
  const shown = lines.slice(0, maxLines);
  const out = [`  ${t.magenta('╭─')} ${t.magenta('✦')} ${headLabel} ${t.dim(`(${lines.length} lines)`)}`];
  const padWidth = String(Math.min(lines.length, maxLines)).length;
  shown.forEach((l, idx) => {
    const num = String(idx + 1).padStart(padWidth, ' ');
    out.push(`  ${t.magenta('│')} ${t.dim(num)}  ${l}`);
  });
  if (lines.length > maxLines) {
    out.push(`  ${t.magenta('│')} ${t.dim(`… +${lines.length - maxLines} more lines`)}`);
  }
  out.push(`  ${t.magenta('╰' + '─'.repeat(36))}`);
  return out;
}
