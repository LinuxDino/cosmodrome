/**
 * Example cosmodrome module. Copy it to ~/.config/cosmodrome/modules/ and restart cosmo.
 * Adds /standup (asks the current agent to draft a standup from recent git history)
 * and shows the current git branch in the status line.
 */
import { execFileSync } from 'node:child_process';

export default function (cosmo) {
  cosmo.addCommand({
    name: 'standup',
    args: '[extra notes]',
    description: 'Draft a standup from the last day of commits',
    run: (args) =>
      cosmo.ask(
        `Look at "git log --since=yesterday --oneline" in this repo and draft a short standup ` +
          `(yesterday / today / blockers). ${args ? `Extra notes: ${args}` : ''}`,
        { saveAs: { title: 'standup', kind: 'note' } },
      ),
  });

  cosmo.addStatusItem(() => {
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: cosmo.cwd, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      return branch ? `⎇ ${branch}` : null;
    } catch {
      return null;
    }
  });
}
