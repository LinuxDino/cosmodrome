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

const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter() : null;

/** What the user sees as one character ("e" + accent, 👨‍👩‍👧, 🇩🇪), so editing never splits one. */
export function graphemes(s) {
  s = String(s);
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/**
 * Columns one grapheme takes. Emoji shown as emoji (✅, 🚀, 🇩🇪, or anything with the
 * emoji selector like ❤️) take two; symbols shown as text (✦ ⏺ ↪) take one.
 */
export function clusterWidth(g) {
  if (g === '\t') return 1; // shown as one space in the input box
  if (/\p{Emoji_Presentation}/u.test(g) || (g.includes('\uFE0F') && /\p{Extended_Pictographic}/u.test(g))) return 2;
  return charWidth(g.codePointAt(0));
}

export function width(s) {
  let w = 0;
  for (const g of graphemes(stripAnsi(s))) w += clusterWidth(g);
  return w;
}

/** Cut a (possibly colored) string to `max` columns. Escape sequences take no room. */
export function truncate(s, max) {
  s = String(s);
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let hadAnsi = false;
  let hadOsc8 = false;
  const close = () => (hadOsc8 ? '\x1b]8;;\x07' : '') + (hadAnsi ? '\x1b[0m' : '');
  for (const part of s.split(new RegExp(`(${ANSI_RE.source})`))) {
    if (!part) continue;
    if (part[0] === '\x1b' && new RegExp(`^(?:${ANSI_RE.source})$`).test(part)) {
      out += part;
      // A cut link must be closed too, or the rest of the screen stays clickable.
      if (part.startsWith('\x1b]8;')) hadOsc8 = true;
      else hadAnsi = true;
      continue;
    }
    for (const g of graphemes(part)) {
      const cw = clusterWidth(g);
      if (w + cw > max - 1) return out + '…' + close();
      out += g;
      w += cw;
    }
  }
  return out + close();
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
    for (const ch of graphemes(part)) {
      if (ch === '\t') {
        const n = 8 - (col % 8);
        out += ' '.repeat(n);
        col += n;
      } else if (!/[\x00-\x1f\x7f]/.test(ch)) {
        out += ch;
        col += clusterWidth(ch);
      }
    }
  }
  return out;
}

export function pad(s, n) {
  const cut = truncate(s, n);
  return cut + ' '.repeat(Math.max(0, n - width(cut)));
}

/**
 * One ASCII character for each symbol the interface draws, so a terminal without UTF-8
 * still lines up (every replacement has the same width as the original).
 */
const ASCII = {
  '⏺': '*', '⎿': '`', '↪': '>', '╭': '+', '╮': '+', '╰': '+', '╯': '+', '─': '-', '│': '|', '┌': '+', '└': '+',
  '├': '+', '❯': '>', '•': '*', '✓': 'v', '✗': 'x', '⏵': '>', '●': '*', '⎇': '@', '↵': '~', '…': '.', '·': '-',
  '✦': '*', '✧': '+', '◉': 'o', '✶': '*', '✸': '*', '✹': '*', '✺': '*', '‾': '-', '⇧': '^', '⟳': '~', '▸': '>',
};
const ASCII_RE = new RegExp(`[${Object.keys(ASCII).join('')}]`, 'g');
export const toAscii = (s) => String(s).replace(ASCII_RE, (ch) => ASCII[ch]);

export class Screen {
  constructor(out = process.stdout, { ascii = false } = {}) {
    this.out = out;
    this.ascii = ascii;
    this.lines = 0;
    this.cursorRow = 0;
  }

  get cols() {
    return Math.max(10, this.out.columns || 80);
  }

  get rows() {
    return Math.max(5, this.out.rows || 24);
  }

  /** Escape codes that erase the prompt area (empty if nothing is drawn). */
  eraseCodes() {
    if (!this.lines) return '';
    let s = '\x1b[?25l';
    const up = this.rowsAboveCursor();
    if (up > 0) s += `\x1b[${up}A`;
    s += '\r\x1b[J';
    this.lines = 0;
    this.cursorRow = 0;
    this.widths = [];
    return s;
  }

  /**
   * Terminal rows between the top of the prompt area and the cursor. Equal to the line
   * index at the width we drew with; after the terminal got narrower, the terminal has
   * re-wrapped our lines, so count the rows each one takes now.
   */
  rowsAboveCursor() {
    const cols = this.cols;
    const widths = this.widths || [];
    let rows = 0;
    for (let i = 0; i < this.cursorRow; i++) rows += Math.max(1, Math.ceil((widths[i] || 0) / cols));
    return rows + Math.floor((this.cursorCol || 0) / cols);
  }

  /**
   * One write per frame, inside synchronized output (DEC 2026) so the terminal shows
   * the finished frame instead of the erase in between. Terminals without it ignore it.
   */
  write(s) {
    if (s) this.out.write(`\x1b[?2026h${this.ascii ? toAscii(s) : s}\x1b[?2026l`);
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
    this.cursorCol = cursor.col;
    this.widths = safe.map((l) => width(l));
  }

  /** Print permanent lines above the prompt area. */
  print(lines) {
    this.write(this.eraseCodes() + lines.join('\n') + '\n');
  }
}
