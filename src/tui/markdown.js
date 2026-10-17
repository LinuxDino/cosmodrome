/** Light, line-by-line markdown styling for agent answers in the terminal. */
export function createMarkdownState() {
  return { fence: null };
}

function inline(s, t) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => t.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => t.bold(b))
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, p, i) => p + t.italic(i))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => `${t.underline(txt)} ${t.dim(`(${url})`)}`);
}

export function renderMarkdownLine(line, state, t) {
  const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
  if (fence) {
    if (!state.fence) {
      state.fence = fence[1];
      return t.dim(`┌─ ${fence[2] || 'code'}`);
    }
    if (fence[1][0] === state.fence[0] && !fence[2]) {
      state.fence = null;
      return t.dim('└─');
    }
  }
  if (state.fence) return `${t.dim('│')} ${t.cyan(line)}`;
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
