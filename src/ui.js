import readline from 'node:readline/promises';

function colorEnabled(stream) {
  return Boolean(stream && stream.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
}

function palette(stream) {
  const wrap = (open, close) => (s) => (colorEnabled(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
  };
}

/** Colors for messages on stderr (banners, hints, errors). */
export const c = palette(process.stderr);
/** Colors for data on stdout (status, lists). */
export const co = palette(process.stdout);

export const log = (...a) => console.error(...a);
export const out = (...a) => console.log(...a);

export const info = (msg) => log(`${c.magenta('◆')} ${msg}`);
export const ok = (msg) => log(`${c.green('✓')} ${msg}`);
export const warn = (msg) => log(`${c.yellow('!')} ${msg}`);
export const fail = (msg) => log(`${c.red('✗')} ${msg}`);

export class CosmoError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.name = 'CosmoError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function ask(question, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = def ? c.dim(` (${def})`) : '';
    const answer = (await rl.question(`${c.magenta('?')} ${question}${suffix}: `)).trim();
    return answer || def;
  } finally {
    rl.close();
  }
}

export async function confirm(question, def = false) {
  const answer = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
  if (!answer) return def;
  return answer === 'y' || answer === 'yes' || answer === 'j' || answer === 'ja';
}

/** Print rows as padded columns (plain text, no colors, so widths stay right). */
export function table(rows, indent = '') {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] || 0, String(cell).length)));
  for (const row of rows) {
    const line = row.map((cell, i) => (i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i]))).join('  ');
    out(indent + line.trimEnd());
  }
}

/** Closest candidate within 2 edits (for "did you mean"), or null. */
export function closest(word, candidates) {
  const dist = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length];
  };
  let best = null;
  for (const c of candidates) {
    const d = dist(String(word).toLowerCase(), c.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
}

/**
 * What to tell the user after an agent run failed. Looks at the error text only to pick
 * a hint; nothing is stored or sent anywhere.
 */
export function failureHint({ agent, label, code, output = '' }) {
  if (code === 127) return `${label} could not be started. Check it with /doctor.`;
  if (/not (logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|\b401\b|\b403\b|api key|credential|expired token|authenticat/i.test(output)) {
    return `Looks like ${label} isn't signed in for this profile: /login ${agent}`;
  }
  if (/unknown (option|argument|flag)|unrecognized|unexpected argument|invalid option/i.test(output)) {
    return `${label} didn't accept cosmo's arguments - it may be too old or too new. Try updating it, or use /native.`;
  }
  if (/rate.?limit|quota|usage limit|\b429\b/i.test(output)) return `${label} hit a usage limit. Wait a bit or switch channel (ctrl+o).`;
  return `/native opens ${label} itself if you need more detail.`;
}
