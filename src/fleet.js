import { CosmoError } from './ui.js';
import { shq } from './system.js';

export function sessionName(profile) {
  return `cosmo-${profile}`;
}

/**
 * Create (or reuse) a tmux session with one pane per agent, all in the same profile.
 * `tmux(args)` runs tmux and returns { status, stdout, stderr } - injected for testing.
 * When an agent exits, its pane drops into a profile shell instead of closing.
 */
export function startFleet({ profile, agents, cwd, cosmoCmd, tmux, insideTmux = false }) {
  if (!agents.length) throw new CosmoError('No agents to launch.');
  const name = sessionName(profile);
  const target = `=${name}:`;
  const exists = tmux(['has-session', '-t', `=${name}`]).status === 0;

  const must = (r, what) => {
    if (r.status !== 0) throw new CosmoError(`tmux failed to ${what}.`, { hint: (r.stderr || '').trim() || undefined });
    return r.stdout.trim();
  };

  if (!exists) {
    const paneCmd = (agent) =>
      `${cosmoCmd} launch --force ${shq(profile)} ${shq(agent)}; exec ${cosmoCmd} shell --quiet ${shq(profile)}`;
    const ids = [];
    ids.push(
      must(
        tmux(['new-session', '-d', '-s', name, '-n', profile, '-c', cwd, '-P', '-F', '#{pane_id}', paneCmd(agents[0])]),
        'create the session',
      ),
    );
    for (const agent of agents.slice(1)) {
      ids.push(must(tmux(['split-window', '-t', target, '-c', cwd, '-P', '-F', '#{pane_id}', paneCmd(agent)]), 'split a pane'));
      tmux(['select-layout', '-t', target, 'tiled']);
    }
    ids.forEach((id, i) => tmux(['select-pane', '-t', id, '-T', agents[i]]));
    tmux(['set-window-option', '-t', target, 'pane-border-status', 'top']);
    tmux(['set-window-option', '-t', target, 'pane-border-format', ' #{pane_title} ']);
    tmux(['select-pane', '-t', ids[0]]);
  }

  return {
    name,
    created: !exists,
    attachArgs: insideTmux ? ['switch-client', '-t', `=${name}`] : ['attach-session', '-t', `=${name}`],
  };
}
