import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentNames, getAgent } from '../agents.js';
import { tildify, expandHome } from '../paths.js';
import { which } from '../system.js';
import { CosmoError } from '../ui.js';
import { listArtifacts, saveArtifact, zipArtifacts, artifactsRoot } from '../artifacts.js';
import { createMarkdownState, renderMarkdownLine, renderPreviewBox } from './markdown.js';
import { runDelegation, runCouncil, listOllamaModels, pickLocalModel } from '../orchestrator.js';
import { loadSkills, loadRules, loadMcpServers, initCustomizations, syncAgentCustomizations } from '../skills.js';

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
        app.channels.all().map((ch) => ({ value: ch.id, hint: [!ch.installed && 'not installed', ch.isDefault && 'default'].filter(Boolean).join(' · ') })),
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
        app.print(`${t.green('✓')} ${t.bold(tildify(file, app.ctx.paths.home))} ${t.dim(`(${count} file${count === 1 ? '' : 's'})`)}`);
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
      name: 'delegate',
      aliases: ['d'],
      args: '<task>',
      description: 'Local AI breaks down & delegates task across agents with failover',
      run: (args) => {
        if (!args) throw new CosmoError('What should Mission Control delegate?', { hint: '/delegate audit src/ and fix edge cases' });
        return runDelegation(args, app);
      },
    },
    {
      name: 'council',
      aliases: ['compare'],
      args: '<question>',
      description: 'Ask multiple agents in parallel and synthesize their answers',
      run: (args) => {
        if (!args) throw new CosmoError('What should the agent council discuss?', { hint: '/council best way to structure git worktrees' });
        return runCouncil(args, null, app);
      },
    },
    {
      name: 'router',
      args: '[on|off|<model>]',
      description: 'Toggle local Ollama router mode or pick the local model',
      complete: () => [
        { value: 'on', hint: 'route default messages through local AI orchestrator' },
        { value: 'off', hint: 'send default messages directly to active channel' },
        ...listOllamaModels({ env: app.ctx.env }).map((m) => ({ value: m, hint: 'local Ollama model' })),
      ],
      run: (args) => {
        const a = (args || '').trim();
        if (!a) {
          app.state.router = !app.state.router;
        } else if (a === 'on') {
          app.state.router = true;
        } else if (a === 'off') {
          app.state.router = false;
        } else {
          app.state.localModel = a;
          app.state.router = true;
        }
        const models = listOllamaModels({ env: app.ctx.env });
        const model = app.state.localModel || pickLocalModel(models, app.config, app.ctx.env);
        app.print(
          app.state.router
            ? `  ${t.magenta('✦')} ${t.bold('Local AI router ON')} ${t.dim(`· model: ${model} · auto-delegates & switches on usage limits`)}`
            : `  ${t.dim('Local AI router OFF · messages go directly to #' + (app.channels.id || 'channel'))}`,
        );
      },
    },
    {
      name: 'preview',
      aliases: ['p'],
      args: '<file|#artifact>',
      description: 'Render an inline terminal preview card for a file or artifact',
      complete: artifactCompletions,
      run: (args) => {
        const q = (args || '').trim();
        if (!q) throw new CosmoError('Specify a file path or artifact number to preview.', { hint: '/preview package.json  or  /preview 1' });
        const candidate = path.resolve(app.state.cwd, expandHome(q, app.ctx.paths.home));
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const lines = fs.readFileSync(candidate, 'utf8').split('\n');
          const rel = path.relative(app.state.cwd, candidate) || path.basename(candidate);
          app.print(renderPreviewBox({ title: rel, url: `file://${candidate}`, lines, t }));
          return;
        }
        const [a] = pickArtifacts(artifactsOf(app).list, q);
        const main = a.files[0] ? path.join(a.dir, a.files[0]) : null;
        const lines = main && fs.existsSync(main) ? fs.readFileSync(main, 'utf8').split('\n') : [];
        app.print(renderPreviewBox({ title: `#${a.n} ${a.title}`, url: `file://${main || a.dir}`, lines, t }));
      },
    },
    {
      name: 'skills',
      args: '[init|sync]',
      description: 'Shared rules & skills across all agents',
      complete: () => [
        { value: 'init', hint: 'create starter rules.md, skills/ and mcp.json' },
        { value: 'sync', hint: 'sync rules, skills and MCP to all profiles now' },
      ],
      run: (args) => {
        const sub = (args || '').trim();
        if (sub === 'init') {
          const created = initCustomizations(app.ctx.paths);
          app.print(
            created.length
              ? created.map((f) => `  ${t.green('✓')} created ${tildify(f, app.ctx.paths.home)}`)
              : `  ${t.dim('Skills, rules.md and mcp.json already exist.')}`,
          );
          return;
        }
        if (sub === 'sync') {
          let count = 0;
          for (const pName of Object.keys(app.config.profiles || {})) {
            for (const aName of agentNames(app.config)) {
              const agent = getAgent(aName, app.config, app.ctx.platform);
              const agentDir = path.join(app.ctx.paths.stationDir, pName, 'agents', agent.name);
              const res = syncAgentCustomizations({ agent, agentDir, paths: app.ctx.paths, cwd: app.state.cwd });
              count += res.synced.length;
            }
          }
          app.print(`  ${t.green('✓')} Synced shared rules, skills & MCP across profiles (${count} file(s) updated).`);
          return;
        }
        const rules = loadRules(app.ctx.paths, app.state.cwd);
        const skills = loadSkills(app.ctx.paths, app.state.cwd);
        app.print([
          t.bold('Shared Rules & Skills'),
          `  ${t.dim(tildify(app.ctx.paths.configDir, app.ctx.paths.home))} ${t.dim('(/skills init to scaffold · /skills sync to push)')}`,
          ...(rules.length ? rules.map((r) => `  ${t.green('✓')} rules (${r.scope})  ${t.dim(tildify(r.path, app.ctx.paths.home))}`) : [`  ${t.dim('no rules.md yet')}`]),
          ...(skills.length
            ? skills.map((s) => `  ${t.magenta('✦')} ${t.bold(s.name.padEnd(20))} ${t.dim(s.description)}`)
            : [`  ${t.dim('no shared skills yet')}`]),
        ]);
      },
    },
    {
      name: 'mcp',
      args: '[init|sync]',
      description: 'Unified MCP servers synced across all agents',
      complete: () => [
        { value: 'init', hint: 'create ~/.config/cosmodrome/mcp.json' },
        { value: 'sync', hint: 'sync MCP servers to all profiles' },
      ],
      run: (args) => {
        const sub = (args || '').trim();
        if (sub === 'init' || sub === 'sync') return app.commands.get('skills').run(sub);
        const { mcpServers, sources } = loadMcpServers(app.ctx.paths, app.state.cwd);
        const names = Object.keys(mcpServers);
        const mcpFile = path.join(app.ctx.paths.configDir, 'mcp.json');
        app.print([
          t.bold('Unified MCP Servers'),
          `  ${t.dim(tildify(mcpFile, app.ctx.paths.home))}`,
          ...(names.length
            ? names.map((n) => `  ${t.green('●')} ${t.bold(n.padEnd(18))} ${t.dim(mcpServers[n].command || mcpServers[n].url || 'configured')}`)
            : [`  ${t.dim('no MCP servers configured yet (use /mcp init, then edit mcp.json)')}`]),
          ...(sources.length ? [t.dim(`  loaded from: ${sources.map((s) => tildify(s, app.ctx.paths.home)).join(', ')}`)] : []),
        ]);
      },
    },
    {
      name: 'usage',
      args: '[reset]',
      description: 'Provider usage, costs, cooldowns & silent failovers',
      complete: () => [{ value: 'reset', hint: 'clear usage cooldowns' }],
      run: (args) => {
        if ((args || '').trim() === 'reset') {
          app.usage.clearCooldowns();
          app.print(`  ${t.green('✓')} Cleared all provider usage cooldowns.`);
          return;
        }
        const rows = app.usage.rows();
        const failovers = app.usage.failovers || [];
        if (!rows.length) {
          app.print(`  ${t.dim('No agent runs recorded yet in this session.')}`);
          return;
        }
        app.print([
          t.bold('Provider Usage & Health'),
          ...rows.map((r) => {
            const id = `${r.profile}/${r.agent}`.padEnd(20);
            const state = r.throttled ? t.yellow(`⟳ cooldown (${r.cooldownSecs}s)`) : t.green('● healthy');
            const cost = r.costUsd > 0 ? ` · $${r.costUsd.toFixed(3)}` : '';
            const limits = r.rateLimits > 0 ? ` · ${r.rateLimits} limit(s)` : '';
            return `  ${id} ${state}  ${t.dim(`${r.runs} run(s)${cost}${limits}`)}`;
          }),
          ...(failovers.length
            ? [
                '',
                t.bold('Recent Silent Failovers'),
                ...failovers.slice(-5).map((f) => `  ${t.yellow('⟳')} #${f.profile}: @${f.from} → @${f.to} ${t.dim(`(${f.reason})`)}`),
              ]
            : []),
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
