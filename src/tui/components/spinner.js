const VERBS = ['Launching', 'Orbiting', 'Docking', 'Calibrating thrusters', 'Charting stars', 'Warping', 'Scanning the cosmos'];
const WIDTH = 7;
const MID = 3;

export const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];

/** Positions of the satellite: in front of the star left to right, then behind it back again. */
const PATH = [
  ...Array.from({ length: WIDTH }, (_, pos) => ({ pos, front: true })),
  ...Array.from({ length: WIDTH - 2 }, (_, i) => ({ pos: WIDTH - 2 - i, front: false })),
];
export const ORBIT_FRAMES = PATH.length;

/** One frame of the orbit, e.g. "(  ◉✦   )". `frame` null = still star (reduced motion). */
export function orbitFrame(frame, { t, glyphs }) {
  const cells = Array(WIDTH).fill(' ');
  cells[MID] = t.magenta(t.bold(glyphs.star));
  const p = frame == null ? null : PATH[frame % PATH.length];
  if (p && p.front) cells[p.pos] = t.cyan(t.bold(glyphs.sat));
  else if (p && p.pos !== MID) cells[p.pos] = t.dim('.');
  return `${t.dim('(')}${cells.join('')}${t.dim(')')}`;
}

export function spinnerLine({ frame, verb, agent, startedAt, t, glyphs = { star: '✦', sat: '◉' }, still = false }) {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  return `${orbitFrame(still ? null : frame, { t, glyphs })}  ${t.magenta(`${verb}…`)} ${t.dim(`(${agent} · ${secs}s · esc to interrupt)`)}`;
}
