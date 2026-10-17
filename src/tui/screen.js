/**
 * Inline renderer: the transcript scrolls normally in the terminal, and only the
 * prompt area at the bottom (input box, menu, status) is redrawn in place.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Cut a (possibly colored) string to `max` columns. */
export function truncate(s, max) {
  s = String(s);
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  let hadAnsi = false;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;?]*[ -\/]*[@-~]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        hadAnsi = true;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max - 1) {
      out += '…';
      break;
    }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return hadAnsi ? out + '\x1b[0m' : out;
}

/**
 * Make program output safe to print above the prompt: keep colors (SGR) only, drop other
 * escape sequences and control characters, keep what a carriage return would leave
 * visible, and expand tabs. Anything else could move the cursor and break the redraw.
 */
export function sanitize(line) {
  let s = String(line);
  if (s.includes('\r')) s = s.split('\r').filter(Boolean).pop() || '';
  s = s.replace(ANSI_RE, (seq) => (/^\x1b\[[0-9;]*m$/.test(seq) ? seq : ''));
  s = s.replace(/\x1b(?!\[[0-9;]*m)./g, ''); // stray escapes, but not the colors kept above
  let out = '';
  let col = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (ch === '\t') {
        const n = 8 - (col % 8);
        out += ' '.repeat(n);
        col += n;
      } else if (!/[\x00-\x1f\x7f]/.test(ch)) {
        out += ch;
        col += charWidth(ch.codePointAt(0));
      }
    }
  }
  return out;
}

export function pad(s, n) {
  const cut = truncate(s, n);
  return cut + ' '.repeat(Math.max(0, n - width(cut)));
}

export class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.lines = 0;
    this.cursorRow = 0;
  }

  get cols() {
    return Math.max(24, this.out.columns || 80);
  }

  get rows() {
    return Math.max(10, this.out.rows || 24);
  }

  /** Escape codes that erase the prompt area (empty if nothing is drawn). */
  eraseCodes() {
    if (!this.lines) return '';
    let s = '\x1b[?25l';
    if (this.cursorRow > 0) s += `\x1b[${this.cursorRow}A`;
    s += '\r\x1b[J';
    this.lines = 0;
    this.cursorRow = 0;
    return s;
  }

  /**
   * One write per frame, inside synchronized output (DEC 2026) so the terminal shows
   * the finished frame instead of the erase in between. Terminals without it ignore it.
   */
  write(s) {
    if (s) this.out.write(`\x1b[?2026h${s}\x1b[?2026l`);
  }

  /** Erase the prompt area. */
  clear() {
    this.write(this.eraseCodes());
  }

  /** Draw the prompt area and park the cursor at {row, col}. */
  render(lines, cursor) {
    let s = this.eraseCodes();
    const safe = lines.map((l) => truncate(l, this.cols - 1));
    s += '\x1b[?25l' + safe.join('\n');
    const up = safe.length - 1 - cursor.row;
    if (up > 0) s += `\x1b[${up}A`;
    s += '\r' + (cursor.col > 0 ? `\x1b[${cursor.col}C` : '') + '\x1b[?25h';
    this.write(s);
    this.lines = safe.length;
    this.cursorRow = cursor.row;
  }

  /** Print permanent lines above the prompt area. */
  print(lines) {
    this.write(this.eraseCodes() + lines.join('\n') + '\n');
  }
}
