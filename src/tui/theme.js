const enabled = () => Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);
const wrap = (open, close) => (s) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

/** Colors for the interactive UI (stdout). */
export const t = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  link: (s, url) => (enabled() && url ? `\x1b]8;;${url}\x07${s}\x1b]8;;\x07` : String(s)),
};

/**
 * Symbols for the logo and spinner. Every one is narrow in all terminals (no East Asian
 * "ambiguous width" characters). Plain ASCII when the locale isn't UTF-8, on the Linux
 * console, or with COSMO_ASCII=1.
 */
export function pickGlyphs(env = process.env) {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  const ascii = env.COSMO_ASCII === '1' || env.TERM === 'linux' || (locale !== '' && !/utf-?8/i.test(locale));
  return ascii ? { star: '*', sat: 'o', ascii: true } : { star: '✦', sat: '◉', ascii: false };
}

/** COSMO_REDUCED_MOTION=1 keeps the spinner still. */
export const reducedMotion = (env = process.env) => env.COSMO_REDUCED_MOTION === '1';
