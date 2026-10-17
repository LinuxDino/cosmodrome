import { charWidth, width, truncate } from '../screen.js';

/** Bordered input box like Claude Code's. Returns lines and the cursor position inside them. */
export function promptBox({ chars, cursor, cols, t, placeholder = '', mode = 'ask', maxVisible = 8 }) {
  const MAX_VISIBLE = Math.max(1, maxVisible);
  const w = Math.max(8, cols - 1);
  const inner = w - 6;
  const shown = chars.map((ch) => (ch === '\n' ? '↵' : ch));

  const chunks = [];
  let cur = { start: 0, text: '', w: 0 };
  shown.forEach((ch, i) => {
    const cw = charWidth(ch.codePointAt(0));
    if (cur.w + cw > inner) {
      chunks.push(cur);
      cur = { start: i, text: '', w: 0 };
    }
    cur.text += ch;
    cur.w += cw;
  });
  chunks.push(cur);
  if (cursor === shown.length && cur.w >= inner) chunks.push({ start: shown.length, text: '', w: 0 });

  let cRow = 0;
  chunks.forEach((c, i) => {
    if (c.start <= cursor) cRow = i;
  });
  const cCol = width(shown.slice(chunks[cRow].start, cursor).join(''));

  let first = 0;
  if (chunks.length > MAX_VISIBLE) first = Math.min(Math.max(0, cRow - MAX_VISIBLE + 1), chunks.length - MAX_VISIBLE);
  const visible = chunks.slice(first, first + MAX_VISIBLE);

  const border = mode === 'auto' ? t.yellow : t.gray;
  const lines = [border('╭' + '─'.repeat(w - 2) + '╮')];
  visible.forEach((c, i) => {
    const isFirst = first + i === 0;
    let text = c.text;
    let tw = c.w;
    if (!chars.length && isFirst && placeholder) {
      const shown = truncate(placeholder, inner);
      text = t.dim(shown);
      tw = width(shown);
    }
    lines.push(`${border('│')} ${isFirst ? t.bold('>') : ' '} ${text}${' '.repeat(Math.max(0, inner - tw))} ${border('│')}`);
  });
  lines.push(border('╰' + '─'.repeat(w - 2) + '╯'));
  return { lines, cursor: { row: 1 + (cRow - first), col: 4 + cCol } };
}
