const FRAMES = ['✶', '✸', '✹', '✺', '✹', '✸'];
const VERBS = ['Launching', 'Orbiting', 'Docking', 'Calibrating thrusters', 'Charting stars', 'Warping', 'Scanning the cosmos'];

export const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];

export function spinnerLine({ frame, verb, agent, startedAt, t }) {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  return `${t.magenta(FRAMES[frame % FRAMES.length])} ${t.magenta(`${verb}…`)} ${t.dim(`(${agent} · ${secs}s · esc to interrupt)`)}`;
}
