import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentNames, getAgent } from '../agents.js';
import { tildify, expandHome } from '../paths.js';
import { which } from '../system.js';
import { CosmoError } from '../ui.js';
import { listArtifacts, saveArtifact, zipArtifacts, artifactsRoot } from '../artifacts.js';
import { createMarkdownState, renderMarkdownLine } from './markdown.js';

export const RESEARCH_PROMPT = (topic) =>
  `Research this topic on the web: ${topic}

Use your web search and fetch tools. Then write a markdown report with:
- a short summary (3-5 sentences)
- key findings, each with an inline source link
- open questions or things that could not be verified
- a "Sources" list at the end
Prefer recent, primary sources and say clearly when something is uncertain.`;

export const ARTIFACT_PROMPT = (what) =>
  `Create the following as complete, ready-to-use file(s): ${what}

Return every file in its own fenced code block whose info string is the file path, for example
\`\`\`README.md   or   \`\`\`js src/index.js
Write the full content of each file - no placeholders or "rest unchanged" parts.
After the files, add a short note on how to use them.`;

function artifactsOf(app) {
  const root = artifactsRoot(app.state.cwd, app.ctx.paths);
  return { root, list: listArtifacts(root) };
}

function pickArtifacts(list, arg) {
  if (!list.length) throw new CosmoError('No artifacts yet.', { hint: 'Create one with /artifact, /research or /save.' });
  const a = String(arg || '').trim();
  if (!a || a === 'last') return [list[list.length - 1]];
  if (a === 'all') return list;
  return a.split(/[\s,]+/).map((x) => {
    const found = list.find((i) => String(i.n) === x.replace(/^#/, ''));
    if (!found) throw new CosmoError(`No artifact #${x}.`, { hint: 'See /artifacts for numbers.' });
    return found;
  });
}

function openPath(app, target) {
  const opener = app.ctx.platform === 'darwin' ? 'open' : 'xdg-open';
  if (!which(opener, app.ctx.env.PATH)) {
    app.print(`  ${app.t.dim(target)}`);
    return;
  }
  const child = spawn(opener, [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  app.print(`  ${app.t.dim(`opened ${tildify(target, app.ctx.paths.home)}`)}`);
}

const artifactCompletions = (app) =>
  ['last', 'all', ...artifactsOf(app).list.slice(-20).reverse().map((a) => String(a.n))].map((v) => {
    const a = artifactsOf(app).list.find((x) => String(x.n) === v);
    return { value: v, hint: a ? a.title : v === 'all' ? 'every artifact' : 'most recent' };
  });

export function registerBuiltinCommands(app) {
  const { t } = app;
  const cmds = [
    {
      name: 'help',
      aliases: ['?'],
      description: 'Commands and shortcuts',
      run: () => app.printHelp(),
    },
    {
      name: 'channel',
      aliases: ['c'],
      args: '[profile/agent]',
      description: 'Switch channel (profile + agent)',
      complete: () =>
        app.channels.all().map((ch) => ({ value: ch.id, hint: `${ch.installed ? '' : 'not installed · '}${ch.isDefault ? 'default' : ''}` })),
      run: (args) => {
        if (!args) return app.commands.get('channels').run('');
        app.channels.switchTo(args);
      },
    },
    {
      name: 'channels',
      description: 'List all channels',
      run: () => {
        const rows = app.channels.all();
        if (!rows.length) return app.print(`  ${t.yellow('!')} No profiles yet - /init`);
        app.print(
          rows.map((ch) => {
            const mark = ch.id === app.channels.id ? t.magenta('●') : ' ';
            const state = ch.installed ? t.green('ready') : t.dim('not installed');
            return `  ${mark} ${ch.id.padEnd(22)} ${state}${ch.isDefault ? t.dim(' · default') : ''}`;
          }),
        );
      },
    },
    {
      name: 'mode',
      args: '[ask|auto]',
      description: 'ask = read-only answers · auto = agent may edit files',
      complete: () => [
        { value: 'ask', hint: 'read, search the web, answer - no edits' },
        { value: 'auto', hint: 'let the agent edit files in this folder' },
      ],
      run: (args) => app.setMode(args || (app.state.mode === 'ask' ? 'auto' : 'ask')),
    },
    {
      name: 'new',
      description: 'Start a fresh conversation in this channel',
      run: () => {
        app.channels.resetSession();
        app.print(`  ${t.dim(`fresh conversation in #${app.channels.id}`)}`);
      },
    },
    {
      name: 'native',
      aliases: ['open-agent'],
      args: '[agent args]',
      description: "Open the agent's own full interface (returns here on exit)",
      run: async (args) => {
        const ch = app.requireChannel();
        const extra = args ? args.split(/\s+/) : [];
        await app.suspend(() => app.cli.launchCmd(['--force', ch.profile, ch.agent, ...extra], app.cliCtx()));
        app.channels.session().continued = true;
      },
    },
    {
      name: 'login',
      args: '[gh|agent]',
      description: 'Sign in for this profile (official login of each CLI)',
      complete: () => [{ value: 'gh', hint: 'GitHub account' }, ...agentNames(app.config).map((a) => ({ value: a, hint: getAgent(a, app.config).label }))],
      run: async (args) => {
        const ch = app.requireChannel();
        await app.suspend(() => app.cli.loginCmd([ch.profile, args || 'gh'], app.cliCtx()));
        app.channels.switchTo(ch);
      },
    },
    {
      name: 'init',
      description: 'Set up profiles (work, private, ...)',
      run: async () => {
        await app.suspend(() => app.cli.initCmd([], app.cliCtx()));
        app.channels.revalidate();
      },
    },
    {
      name: 'profile',
      args: 'add|set|list|show|default|remove ...',
      description: 'Manage profiles',
      complete: () =>
        ['add', 'set', 'list', 'show', 'default', 'remove'].map((v) => ({ value: v, hint: '' })),
      run: async (args) => {
        const argv = args ? args.split(/\s+/) : ['list'];
        const quiet = ['list', 'ls', 'show'].includes(argv[0]);
        if (quiet) await app.withOutput(() => app.cli.profileCmd(argv, app.cliCtx()));
        else await app.suspend(() => app.cli.profileCmd(argv, app.cliCtx()));
        app.channels.revalidate();
      },
    },
    {
      name: 'status',
      description: 'Accounts, identity and agents per profile',
      run: () => app.withOutput(() => app.cli.statusCmd([], app.cliCtx())),
    },
    {
      name: 'doctor',
      description: 'Check what is installed',
      run: () => app.withOutput(() => app.cli.doctorCmd([], app.cliCtx())),
    },
    {
      name: 'agents',
      description: 'Built-in and custom agents',
      run: () => app.withOutput(() => app.cli.agentsCmd([], app.cliCtx())),
    },
    {
      name: 'fleet',
      args: '[agents...]',
      description: 'Several agents side by side in tmux',
      complete: () => agentNames(app.config).map((a) => ({ value: a, hint: getAgent(a, app.config).label })),
      run: async (args) => {
        const ch = app.requireChannel();
        await app.suspend(() => app.cli.fleetCmd([ch.profile, ...(args ? args.split(/\s+/) : []), '--force'], app.cliCtx()));
      },
    },
    {
      name: 'shell',
      description: "Interactive shell with this profile's GitHub + git identity",
      run: async () => {
        const ch = app.requireChannel();
        await app.suspend(() => app.cli.shellCmd([ch.profile], app.cliCtx()));
      },
    },
    {
      name: 'cd',
      args: '<folder>',
      description: 'Change folder (auto-switches channel by workdir)',
      run: (args) => {
        const target = path.resolve(app.state.cwd, expandHome(args || '~', app.ctx.paths.home));
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new CosmoError(`Not a folder: ${target}`);
        app.state.cwd = target;
        app.print(`  ${t.dim(tildify(target, app.ctx.paths.home))}`);
        app.channels.autoSelect({ quietIfSame: true });
      },
    },
    {
      name: 'research',
      args: '<topic>',
      description: 'Web research -> markdown report saved as artifact',
      run: (args) => {
        if (!args) throw new CosmoError('What should I research?', { hint: '/research best practices for npm trusted publishing' });
        return app.sendPrompt(RESEARCH_PROMPT(args), { echo: false, saveAs: { title: args, kind: 'research' } });
      },
    },
    {
      name: 'artifact',
      aliases: ['make'],
      args: '<what to create>',
      description: 'Have the agent create files -> saved as artifact',
      run: (args) => {
        if (!args) throw new CosmoError('What should the agent create?', { hint: '/artifact a README and a GitHub Actions CI workflow for this repo' });
        return app.sendPrompt(ARTIFACT_PROMPT(args), { echo: false, saveAs: { title: args, kind: 'artifact' } });
      },
    },
    {
      name: 'save',
      args: '[title]',
      description: 'Save the last answer as an artifact',
      run: (args) => {
        const last = app.lastResponse;
        if (!last?.text) throw new CosmoError('Nothing to save yet.');
        app.saveResponse({ ...last, title: args || last.title || last.prompt.slice(0, 50) });
      },
    },
    {
      name: 'artifacts',
      description: 'List saved artifacts',
      run: () => {
        const { root, list } = artifactsOf(app);
        if (!list.length) return app.print(`  ${t.dim(`no artifacts yet in ${tildify(root, app.ctx.paths.home)}`)}`);
        app.print([
          t.dim(`  ${tildify(root, app.ctx.paths.home)}`),
          ...list.map((a) => `  ${t.magenta(`#${a.n}`.padEnd(4))} ${a.title.slice(0, 50).padEnd(50)} ${t.dim(`${a.kind} · ${a.files.length} file(s)`)}`),
        ]);
      },
    },
    {
      name: 'show',
      args: '[n]',
      description: 'Show an artifact',
      complete: artifactCompletions,
      run: (args) => {
        const [a] = pickArtifacts(artifactsOf(app).list, args);
        const main = a.files[0] ? path.join(a.dir, a.files[0]) : null;
        const md = createMarkdownState();
        const body = main && fs.existsSync(main) ? fs.readFileSync(main, 'utf8').split('\n').slice(0, 40) : [];
        app.print([
          `${t.magenta(`#${a.n}`)} ${t.bold(a.title)} ${t.dim(tildify(a.dir, app.ctx.paths.home))}`,
          ...a.files.map((f) => `  ${t.dim('•')} ${f}`),
          '',
          ...body.map((l) => `  ${renderMarkdownLine(l, md, t)}`),
        ]);
      },
    },
    {
      name: 'open',
      args: '[n]',
      description: 'Open an artifact folder',
      complete: artifactCompletions,
      run: (args) => {
        const [a] = pickArtifacts(artifactsOf(app).list, args);
        openPath(app, a.dir);
      },
    },
    {
      name: 'zip',
      args: '[n|all|last]',
      description: 'Bundle artifacts into a .zip',
      complete: artifactCompletions,
      run: (args) => {
        const { root, list } = artifactsOf(app);
        const picked = pickArtifacts(list, args);
        const { file, count } = zipArtifacts(root, picked);
        app.print(`${t.green('✓')} ${t.bold(tildify(file, app.ctx.paths.home))} ${t.dim(`(${count} files)`)}`);
      },
    },
    {
      name: 'modules',
      description: 'Loaded modules (custom commands)',
      run: () => {
        const { loaded = [], errors = [] } = app.modules || {};
        const dir = tildify(path.join(app.ctx.paths.configDir, 'modules'), app.ctx.paths.home);
        app.print([
          t.dim(`  ${dir}`),
          ...(loaded.length ? loaded.map((m) => `  ${t.green('✓')} ${m.name}  ${t.dim(m.commands.map((c) => '/' + c).join(' '))}`) : [`  ${t.dim('no modules yet')}`]),
          ...errors.map((e) => `  ${t.red('✗')} ${e.name}  ${t.dim(e.message)}`),
        ]);
      },
    },
    {
      name: 'clear',
      description: 'Clear the screen',
      run: () => app.clearScreen(),
    },
    {
      name: 'exit',
      aliases: ['quit', 'q'],
      description: 'Leave cosmodrome',
      run: () => app.exit(0),
    },
  ];
  for (const cmd of cmds) app.registerCommand(cmd);
}

export { saveArtifact };
