import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Screen, sanitize, graphemes } from './screen.js';
import { t, pickGlyphs, reducedMotion } from './theme.js';
import { header } from './components/header.js';
import { promptBox } from './components/promptBox.js';
import { menu } from './components/menu.js';
import { statusLine } from './components/statusLine.js';
import { spinnerLine, pickVerb } from './components/spinner.js';
import { createMarkdownState, renderMarkdownLine } from './markdown.js';
import { registerBuiltinCommands } from './commands.js';
import { ChannelManager, recordRun } from './channels.js';
import { runProcess } from './runner.js';
import { loadModules } from './modules.js';
import { loadConfig, emptyConfig } from '../config.js';
import { getAgent, buildHeadless, agentNames, canonicalAgentName } from '../agents.js';
import { tildify } from '../paths.js';
import { which } from '../system.js';
import { CosmoError, closest, failureHint } from '../ui.js';
import { saveArtifact, artifactsRoot, listArtifacts } from '../artifacts.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const HISTORY_MAX = 500;

export class App {
  constructor(ctx, cli) {
    this.ctx = ctx;
    this.cli = cli;
    this.t = t;
    this.glyphs = pickGlyphs(ctx.env);
    this.screen = new Screen(process.stdout, { ascii: this.glyphs.ascii });
    this.still = reducedMotion(ctx.env);
    this.commands = new Map();
    this.aliases = new Map();
    this.statusItems = [];
    this.modules = { loaded: [], errors: [] };
    this.lastResponse = null;
    this.exited = false;
    this.historyFile = path.join(path.dirname(ctx.paths.stationDir), 'history.txt');
    this.state = {
      input: [],
      cursor: 0,
      menuIndex: 0,
      menuDismissed: false,
      mode: 'ask',
      history: this.loadHistory(),
      histIdx: null,
      draft: null,
      running: null,
      notice: null,
      exitArmedAt: 0,
      suspended: false,
      pasting: false,
      cwd: ctx.cwd,
      spinnerFrame: 0,
    };
    this.config = loadConfig(ctx.paths) || emptyConfig();
    this.channels = new ChannelManager(this);
  }

  // ------------------------------------------------------------ plumbing

  cliCtx() {
    return { ...this.ctx, cwd: this.state.cwd, interactive: true };
  }

  reloadConfig() {
    try {
      this.config = loadConfig(this.ctx.paths) || emptyConfig();
    } catch (err) {
      this.printError(err);
    }
  }

  registerCommand(cmd) {
    this.commands.set(cmd.name, cmd);
    for (const a of cmd.aliases || []) this.aliases.set(a, cmd.name);
  }

  getCommand(name) {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name));
  }

  /** API handed to user modules. */
  moduleApi(moduleName, added) {
    const app = this;
    return {
      version: VERSION,
      theme: t,
      addCommand(cmd) {
        if (!cmd?.name || typeof cmd.run !== 'function') throw new Error('addCommand needs { name, run }');
        app.registerCommand({ ...cmd, module: moduleName });
        added.push(cmd.name);
      },
      addStatusItem(fn) {
        app.statusItems.push(fn);
      },
      print: (x) => app.print(x),
      ask: (prompt, opts) => app.sendPrompt(prompt, { echo: false, ...opts }),
      get channel() {
        return app.channels.current ? { ...app.channels.current } : null;
      },
      get cwd() {
        return app.state.cwd;
      },
    };
  }

  loadHistory() {
    try {
      return fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  pushHistory(text) {
    const h = this.state.history;
    if (h[h.length - 1] !== text) h.push(text);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.writeFileSync(this.historyFile, h.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
    } catch {
      /* history is best effort */
    }
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    this.modules = await loadModules(this);
    registerBuiltinCommands(this); // registered after modules, so built-in names can't be overridden
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin, { escapeCodeTimeout: 50 });
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write('\x1b[?2004h');
    this.keyHandler = (str, key) => this.onKey(str, key);
    stdin.on('keypress', this.keyHandler);
    this.resizeHandler = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.render(), 50);
    };
    process.stdout.on('resize', this.resizeHandler);
    this.restoreOnExit = () => {
      this.state.running?.signal?.('SIGTERM');
      this.restoreTerminal();
    };
    process.on('exit', this.restoreOnExit);
    // A bug must not leave the terminal in raw mode or an agent running on its own.
    this.crashHandler = (err) => {
      this.state.running?.signal?.('SIGTERM');
      this.screen.clear();
      this.restoreTerminal();
      process.stderr.write(`\n✗ cosmo crashed: ${err?.stack || err}\n`);
      process.exit(1);
    };
    process.on('uncaughtException', this.crashHandler);
    process.on('unhandledRejection', this.crashHandler);
    // Ctrl+Z: give the terminal back to the shell; `fg` brings the interface back.
    this.contHandler = () => {
      if (this.exited) return;
      process.stdin.setRawMode(true);
      process.stdout.write('\x1b[?2004h');
      this.render();
    };
    process.on('SIGCONT', this.contHandler);
    // Agents run in their own process group, so pass a closing terminal on to them.
    for (const [sig, code] of [['SIGHUP', 129], ['SIGTERM', 143]]) {
      process.once(sig, () => {
        this.state.running?.signal?.(sig);
        this.restoreTerminal();
        process.exit(code);
      });
    }

    this.print(header({ version: VERSION, cwd: tildify(this.state.cwd, this.ctx.paths.home), cols: this.screen.cols, t, glyphs: this.glyphs }));
    for (const e of this.modules.errors) this.print(`  ${t.red('✗')} module ${e.name}: ${t.dim(e.message)}`);
    if (!Object.keys(this.config.profiles).length) {
      this.print(`  ${t.yellow('!')} No profiles yet - type ${t.bold('/init')} to set up work and private profiles.`);
    } else {
      this.channels.autoSelect();
    }
    this.render();
    return new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  restoreTerminal() {
    try {
      process.stdout.write('\x1b[?2004l\x1b[?25h');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* terminal already gone */
    }
  }

  exit(code = 0) {
    if (this.exited) return;
    this.state.running?.cancel?.();
    this.screen.clear();
    this.exited = true;
    clearInterval(this.spinnerTimer);
    process.stdin.off('keypress', this.keyHandler);
    process.stdout.off('resize', this.resizeHandler);
    this.restoreTerminal();
    process.stdin.pause();
    process.stdout.write(`${t.magenta(this.glyphs.star)} ${t.dim('See you in orbit.')}\n`);
    this.resolveExit?.(code);
  }

  /** Hand the terminal to something interactive (wizard, native agent, tmux) and come back. */
  async suspend(fn) {
    const s = this.state;
    this.screen.clear();
    s.suspended = true;
    process.stdout.write('\x1b[?2004l\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
    try {
      return await fn();
    } finally {
      process.stdin.resume();
      process.stdin.setRawMode(true);
      process.stdout.write('\x1b[?2004h');
      s.suspended = false;
      this.reloadConfig();
      this.render();
    }
  }

  /** Let plain console output (status tables etc.) print above the prompt. */
  async withOutput(fn) {
    this.screen.clear();
    this.state.suspended = true;
    try {
      return await fn();
    } finally {
      this.state.suspended = false;
      this.render();
    }
  }

  // ------------------------------------------------------------ output

  print(x) {
    const lines = Array.isArray(x) ? x : String(x).split('\n');
    if (this.state.suspended) {
      process.stdout.write(lines.join('\n') + '\n');
      return;
    }
    this.screen.print(lines);
    this.render();
  }

  printError(err) {
    const lines = [`${t.red('✗')} ${err.message || String(err)}`];
    if (err.hint) lines.push(`  ${t.dim(err.hint)}`);
    if (!(err instanceof CosmoError) && err.stack && this.ctx.env.COSMO_DEBUG) lines.push(t.dim(err.stack));
    this.print(lines);
  }

  clearScreen() {
    this.screen.clear();
    process.stdout.write('\x1b[2J\x1b[H'); // scrollback stays
    this.screen.lines = 0;
    this.print(header({ version: VERSION, cwd: tildify(this.state.cwd, this.ctx.paths.home), cols: this.screen.cols, t, glyphs: this.glyphs, compact: true }));
  }

  printHelp() {
    const cmds = [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.print([
      t.bold('Commands'),
      ...cmds.map((c) => `  ${t.magenta(`/${c.name}`.padEnd(12))} ${(c.args || '').padEnd(18)} ${t.dim(c.description || '')}${c.module ? t.dim(` [${c.module}]`) : ''}`),
      '',
      t.bold('Prefixes'),
      `  ${t.magenta('#work/claude')}  switch channel (add text to send right away)`,
      `  ${t.magenta('@copilot ...')}  ask another agent of this profile once`,
      `  ${t.magenta('!git status')}   run a shell command with this profile's identity`,
      '',
      t.bold('Keys'),
      `  ${t.dim('enter send · tab complete · ↑↓ history/menu · shift+tab ask/auto · ctrl+o next agent')}`,
      `  ${t.dim('esc interrupt/clear · ctrl+l clear screen · ctrl+c twice exit · alt+enter new line')}`,
    ]);
  }

  setMode(mode) {
    if (!['ask', 'auto'].includes(mode)) throw new CosmoError('Mode is ask or auto.');
    this.state.mode = mode;
    this.print(
      mode === 'auto'
        ? `  ${t.yellow('⏵⏵ auto mode')} ${t.dim('- the agent may edit files in this folder')}`
        : `  ${t.dim('ask mode - read, search and answer, no edits')}`,
    );
  }

  requireChannel() {
    if (!this.channels.current) throw new CosmoError('No channel yet.', { hint: 'Run /init or /channel profile/agent.' });
    return this.channels.current;
  }

  // ------------------------------------------------------------ rendering

  suggestions() {
    const s = this.state;
    if (s.menuDismissed || s.running) return [];
    const text = s.input.join('');
    if (text.includes('\n')) return [];
    let m;
    if ((m = text.match(/^\/(\S*)$/))) {
      const q = m[1].toLowerCase();
      const all = [...this.commands.values()];
      const starts = all.filter((c) => c.name.startsWith(q) || (c.aliases || []).some((a) => a.startsWith(q)));
      const contains = all.filter((c) => !starts.includes(c) && c.name.includes(q));
      return [...starts.sort((a, b) => a.name.localeCompare(b.name)), ...contains].map((c) => ({
        label: `/${c.name}`,
        hint: `${c.args ? c.args + '  ' : ''}${c.description || ''}`,
        value: c.args ? `/${c.name} ` : `/${c.name}`,
        submit: !c.args,
      }));
    }
    if ((m = text.match(/^\/(\S+)\s(\S*)$/))) {
      const cmd = this.getCommand(m[1]);
      if (!cmd?.complete) return [];
      let items = [];
      try {
        items = cmd.complete(this) || [];
      } catch {
        return [];
      }
      const q = m[2].toLowerCase();
      return items
        .filter((i) => i.value.toLowerCase().startsWith(q) && i.value !== m[2])
        .map((i) => ({ label: i.value, hint: i.hint, value: `/${m[1]} ${i.value}`, submit: true }));
    }
    if ((m = text.match(/^#(\S*)$/))) {
      const q = m[1].toLowerCase();
      return this.channels
        .all()
        .filter((ch) => ch.id.startsWith(q) || ch.agent.startsWith(q))
        .sort((a, b) => a.profile.localeCompare(b.profile) || b.isDefault - a.isDefault || b.installed - a.installed)
        .map((ch) => ({ label: `#${ch.id}`, hint: ch.installed ? (ch.isDefault ? 'default' : '') : 'not installed', value: `#${ch.id}`, submit: true }));
    }
    if ((m = text.match(/^@(\S*)$/))) {
      const q = m[1].toLowerCase();
      return agentNames(this.config)
        .filter((a) => a.startsWith(q) && a !== this.channels.current?.agent)
        .map((a) => ({ label: `@${a}`, hint: getAgent(a, this.config).label, value: `@${a} `, submit: false }));
    }
    return [];
  }

  render() {
    if (this.state.suspended || this.exited) return;
    const s = this.state;
    const cols = this.screen.cols;
    const lines = [];
    if (s.running) {
      lines.push(spinnerLine({ frame: s.spinnerFrame, verb: s.running.verb, agent: s.running.agent, startedAt: s.running.startedAt, t, glyphs: this.glyphs, still: this.still }));
      lines.push('');
    }
    const top = lines.length;
    // Keep the whole prompt area on screen: it can't be erased once it scrolls off the top.
    const budget = this.screen.rows - 1 - top;
    const box = promptBox({
      maxVisible: Math.min(8, budget - 4),
      chars: s.input,
      cursor: s.cursor,
      cols,
      t,
      mode: s.mode,
      placeholder: s.running ? 'Agent is working… (esc to interrupt)' : this.channels.current ? `Message #${this.channels.id} · / for commands` : 'Type /init to get started',
    });
    lines.push(...box.lines);
    const sugg = this.suggestions();
    if (s.menuIndex >= sugg.length) s.menuIndex = 0;
    if (sugg.length) lines.push(...menu({ items: sugg, index: s.menuIndex, t, maxItems: Math.min(8, budget - box.lines.length - 1) }));
    else {
      lines.push(...statusLine({ channel: this.channels.id, mode: s.mode, ghUser: this.channels.ghUser, cwd: tildify(s.cwd, this.ctx.paths.home), notice: s.notice, items: this.statusItemValues(), t, cols }));
    }
    this.screen.render(lines, { row: top + box.cursor.row, col: box.cursor.col });
  }

  /** Module status items, refreshed at most every 2 seconds (render runs often). */
  statusItemValues() {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.at < 2000 && this.statusCache.cwd === this.state.cwd) return this.statusCache.items;
    const items = [];
    for (const fn of this.statusItems) {
      try {
        const v = fn(this);
        if (v) items.push(String(v));
      } catch {
        /* ignore broken status items */
      }
    }
    this.statusCache = { at: now, cwd: this.state.cwd, items };
    return items;
  }

  // ------------------------------------------------------------ input

  setInput(text) {
    this.state.input = graphemes(text);
    this.state.cursor = this.state.input.length;
    this.state.menuIndex = 0;
    this.state.menuDismissed = false;
  }

  insert(str) {
    const s = this.state;
    const chars = graphemes(str);
    s.input.splice(s.cursor, 0, ...chars);
    s.cursor += chars.length;
    s.menuDismissed = false;
    s.menuIndex = 0;
    s.histIdx = null;
  }

  deleteWordBack() {
    const s = this.state;
    let i = s.cursor;
    while (i > 0 && /\s/.test(s.input[i - 1])) i--;
    while (i > 0 && !/\s/.test(s.input[i - 1])) i--;
    s.input.splice(i, s.cursor - i);
    s.cursor = i;
  }

  historyMove(dir) {
    const s = this.state;
    if (!s.history.length) return;
    if (s.histIdx === null) {
      if (dir > 0) return;
      s.draft = s.input.join('');
      s.histIdx = s.history.length;
    }
    s.histIdx = Math.max(0, Math.min(s.history.length, s.histIdx + dir));
    const text = s.histIdx === s.history.length ? s.draft || '' : s.history[s.histIdx];
    const keep = s.histIdx;
    this.setInput(text);
    s.histIdx = keep === s.history.length ? null : keep;
  }

  onKey(str, key) {
    if (this.state.suspended || this.exited) return;
    try {
      this.handleKey(str, key || {});
    } catch (err) {
      this.printError(err);
    }
  }

  handleKey(str, key) {
    const s = this.state;
    if (key.name !== 'c' || !key.ctrl) s.notice = null;

    if (key.name === 'paste-start') {
      s.pasting = true;
      return;
    }
    if (key.name === 'paste-end') {
      s.pasting = false;
      return this.render();
    }
    if (s.pasting) {
      if (key.name === 'return' || key.name === 'enter') this.insert('\n');
      else if (str && !/^[\x00-\x08\x0b-\x1f\x7f]$/.test(str)) this.insert(str.replace(/\r\n?/g, '\n'));
      return;
    }

    if (key.ctrl && key.name === 'c') {
      if (s.running) return this.cancelRun();
      if (s.input.length) {
        this.setInput('');
        return this.render();
      }
      if (Date.now() - s.exitArmedAt < 1500) return this.exit(0);
      s.exitArmedAt = Date.now();
      s.notice = 'Press Ctrl+C again to exit';
      return this.render();
    }
    if (key.ctrl && key.name === 'd') {
      if (!s.input.length) return this.exit(0);
      if (s.cursor < s.input.length) s.input.splice(s.cursor, 1);
      return this.render();
    }
    if (key.name === 'escape') {
      if (s.running) return this.cancelRun();
      if (this.suggestions().length) s.menuDismissed = true;
      else this.setInput('');
      return this.render();
    }

    const sugg = this.suggestions();
    if (key.name === 'up' || key.name === 'down') {
      const dir = key.name === 'up' ? -1 : 1;
      if (sugg.length) s.menuIndex = (s.menuIndex + dir + sugg.length) % sugg.length;
      else this.historyMove(dir);
      return this.render();
    }
    if (key.name === 'tab') {
      if (key.shift) this.setMode(s.mode === 'ask' ? 'auto' : 'ask');
      else if (sugg.length) this.setInput(sugg[s.menuIndex].value);
      return this.render();
    }
    // New line: Alt+Enter, Ctrl+J (sends "enter", where Enter sends "return"), or "\" + Enter.
    if (key.name === 'enter' && !key.meta && str === '\n') {
      this.insert('\n');
      return this.render();
    }
    if ((key.name === 'return' || key.name === 'enter') && !key.meta && s.input[s.cursor - 1] === '\\') {
      s.input.splice(s.cursor - 1, 1, '\n');
      return this.render();
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (key.meta) {
        this.insert('\n');
        return this.render();
      }
      if (sugg.length) {
        const item = sugg[s.menuIndex];
        // A command typed out in full runs right away; its arguments are optional or it says what's missing.
        const typed = s.input.join('');
        const complete = typed.startsWith('/') && item.value.trimEnd() === typed;
        this.setInput(item.value);
        if (!item.submit && !complete) return this.render();
      }
      return this.submit();
    }
    if (key.name === 'backspace') {
      if (key.meta || key.ctrl) this.deleteWordBack();
      else if (s.cursor > 0) {
        s.input.splice(s.cursor - 1, 1);
        s.cursor--;
      }
      s.menuDismissed = false;
      return this.render();
    }
    if (key.name === 'delete') {
      if (s.cursor < s.input.length) s.input.splice(s.cursor, 1);
      return this.render();
    }
    if (key.name === 'left') s.cursor = Math.max(0, s.cursor - 1);
    else if (key.name === 'right') s.cursor = Math.min(s.input.length, s.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) s.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) s.cursor = s.input.length;
    else if (key.ctrl && key.name === 'u') {
      s.input.splice(0, s.cursor);
      s.cursor = 0;
    } else if (key.ctrl && key.name === 'k') s.input.splice(s.cursor);
    else if (key.ctrl && key.name === 'w') this.deleteWordBack();
    else if (key.ctrl && key.name === 'l') return this.clearScreen();
    else if (key.ctrl && key.name === 'z') return this.suspendToShell();
    else if (key.ctrl && key.name === 'o') this.channels.cycleAgent();
    else if (str === '?' && !s.input.length && !key.ctrl && !key.meta) return this.printHelp();
    else if (str && !key.ctrl && !key.meta && !/[\x00-\x08\x0b-\x1f\x7f]/.test(str)) this.insert(str.replace(/\r\n?/g, '\n'));
    this.render();
  }

  async submit() {
    const s = this.state;
    const text = s.input.join('').trim();
    if (!text) return this.render();
    if (s.running) {
      s.notice = 'An agent is still working - esc to interrupt';
      return this.render();
    }
    this.pushHistory(text);
    s.histIdx = null;
    this.setInput('');
    this.print(text.split('\n').map((l, i) => `${t.gray(i ? '  ' : '> ')}${t.gray(l)}`));
    try {
      await this.dispatch(text);
    } catch (err) {
      this.printError(err);
    }
    this.render();
  }

  async dispatch(text) {
    let m;
    if (text.startsWith('/')) {
      m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
      const cmd = this.getCommand(m[1]);
      if (!cmd) {
        const guess = closest(m[1], [...this.commands.keys()]);
        throw new CosmoError(`Unknown command /${m[1]}`, { hint: guess ? `Did you mean /${guess}?` : 'Type / to see all commands.' });
      }
      return cmd.run(m[2].trim(), this);
    }
    if (text.startsWith('!')) return this.runShell(text.slice(1).trim());
    if ((m = text.match(/^#(\S+)\s*([\s\S]*)$/))) {
      this.channels.switchTo(m[1]);
      if (m[2].trim()) return this.sendPrompt(m[2].trim(), { echo: false });
      return;
    }
    if ((m = text.match(/^@(\S+)\s*([\s\S]*)$/))) {
      const agent = canonicalAgentName(m[1], this.config);
      if (!agent) {
        const guess = closest(m[1], agentNames(this.config));
        throw new CosmoError(`Unknown agent "${m[1]}".`, { hint: guess ? `Did you mean @${guess}?` : `Agents: ${agentNames(this.config).join(', ')}` });
      }
      if (!m[2].trim()) throw new CosmoError(`Type a message after @${agent}.`, { hint: `e.g. @${agent} review my last commit` });
      return this.sendPrompt(m[2].trim(), { agent, echo: false });
    }
    return this.sendPrompt(text, { echo: false });
  }

  // ------------------------------------------------------------ running things

  startRun(agent, handle) {
    const s = this.state;
    s.running = { agent, verb: pickVerb(), startedAt: Date.now(), cancel: handle.cancel, signal: handle.signal };
    this.spinnerTimer = setInterval(() => {
      s.spinnerFrame++;
      this.render();
    }, 120);
  }

  endRun() {
    clearInterval(this.spinnerTimer);
    this.state.running = null;
    if (this.state.notice?.startsWith('Interrupting')) this.state.notice = null;
  }

  cancelRun() {
    const r = this.state.running;
    if (!r) return;
    r.cancel?.();
    this.state.notice = r.interrupted ? 'Interrupting… (stopping it now)' : 'Interrupting… (esc again to force-stop)';
    r.interrupted = true;
    this.render();
  }

  suspendToShell() {
    this.screen.clear();
    this.restoreTerminal();
    process.stdout.write(t.dim('cosmo is in the background - type fg to come back\n'));
    process.kill(process.pid, 'SIGTSTP');
  }

  /** Stream lines of an answer with ⏺ on the first line, like Claude Code. */
  makeWriter(prefixFirst = `${t.magenta('⏺')} `, prefixRest = '  ', { markdown = true } = {}) {
    const md = createMarkdownState();
    let first = true;
    return (text) => {
      const lines = String(text).split('\n').map((l) => {
        const out = (first ? prefixFirst : prefixRest) + (markdown ? renderMarkdownLine(sanitize(l), md, t) : sanitize(l));
        first = false;
        return out;
      });
      this.print(lines);
    };
  }

  async sendPrompt(prompt, { agent: agentOverride, saveAs, echo = true } = {}) {
    const ch = this.requireChannel();
    if (echo) this.print(`${t.gray('> ')}${t.gray(prompt)}`);
    const agentName = agentOverride ? canonicalAgentName(agentOverride, this.config) : ch.agent;
    const agent = getAgent(agentName, this.config, this.ctx.platform);
    if (!agent) throw new CosmoError(`Unknown agent "${agentOverride || agentName}".`, { hint: `Agents: ${agentNames(this.config).join(', ')}` });
    const bin = this.cli.requireBin(agent, this.ctx);
    const session = this.channels.session(ch.profile, agent.name);
    if (session.moved) this.print(t.dim(`  new conversation for ${tildify(this.state.cwd, this.ctx.paths.home)} (agents keep conversations per folder)`));
    const args = buildHeadless(agent, prompt, { ...session, mode: this.state.mode });
    if (!args) {
      throw new CosmoError(`${agent.label} has no one-shot mode configured.`, { hint: 'Use /native, or add "headless" to the agent in cosmo config edit.' });
    }
    const plan = this.cli.plan(this.config, ch.profile, agent, this.cliCtx());
    if (agentOverride) this.print(t.dim(`  asking @${agent.name} in #${ch.profile}`));

    let write = this.makeWriter();
    const startedAt = Date.now();
    const handle = runProcess({
      bin,
      args,
      env: plan.env,
      cwd: this.state.cwd,
      format: agent.headless?.stream || 'text',
      onText: (text, info) => {
        if (info?.block) write = this.makeWriter();
        write(text);
      },
      onTool: (name, detail) => {
        this.print(`${t.magenta('⏺')} ${t.bold(name)}${detail ? t.dim(`(${detail})`) : ''}`);
        write = this.makeWriter();
      },
    });
    this.startRun(agent.name, handle);
    this.render();
    const res = await handle.promise;
    this.endRun();

    recordRun(session, res);
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const meta = [agent.name];
    if (res.result?.duration_ms) meta.push(`${Math.round(res.result.duration_ms / 1000)}s`);
    else if (secs) meta.push(`${secs}s`);
    if (res.result?.total_cost_usd) meta.push(`$${res.result.total_cost_usd.toFixed(3)}`);
    if (res.cancelled) meta.push('interrupted');
    else if (res.code) meta.push(`exit ${res.code}`);
    if (!res.text.trim() && !res.cancelled && res.code === 0) {
      this.print(t.dim(`  (no output)${agent.headless?.emptyHint ? ' ' + agent.headless.emptyHint : ''}`));
    }
    if (res.code && !res.cancelled && res.stderr.trim()) {
      this.print(res.stderr.trim().split('\n').slice(-6).map((l) => `  ${t.red(sanitize(l))}`));
    }
    this.print(t.dim(`  ⎿ ${meta.join(' · ')}`));
    if (res.code && !res.cancelled) {
      const hint = failureHint({ agent: agent.name, label: agent.label, code: res.code, output: `${res.stderr}\n${res.result?.result || ''}\n${res.text}` });
      this.print(`  ${t.yellow('!')} ${hint}`);
    }

    this.lastResponse = { text: res.text, prompt, channel: `${ch.profile}/${agent.name}`, title: saveAs?.title };
    if (saveAs && res.text.trim() && !res.cancelled) this.saveResponse({ ...this.lastResponse, ...saveAs });
    return res;
  }

  saveResponse({ text, prompt, channel, title, kind = 'note' }) {
    const root = artifactsRoot(this.state.cwd, this.ctx.paths);
    const saved = saveArtifact(root, { title: title || 'note', text, channel, prompt, kind });
    const n = listArtifacts(root).findIndex((a) => a.dir === saved.dir) + 1;
    this.print([
      `${t.green('✓')} Saved artifact ${t.magenta(`#${n}`)} ${t.dim(`(${saved.files.length} file${saved.files.length === 1 ? '' : 's'})`)} ${t.dim(tildify(saved.dir, this.ctx.paths.home))}`,
      ...saved.files.slice(0, 12).map((f) => `  ${t.dim('•')} ${f}`),
      t.dim(`  /zip ${n} to bundle · /open ${n} to open`),
    ]);
    return saved;
  }

  async runShell(command) {
    if (!command) throw new CosmoError('Type a command after !, e.g. !git status');
    const ch = this.channels.current;
    const env = ch ? this.cli.plan(this.config, ch.profile, null, this.cliCtx()).env : this.ctx.env;
    const write = this.makeWriter(`  ${t.dim('⎿')} `, '    ', { markdown: false });
    const handle = runProcess({ bin: '/bin/sh', args: ['-c', `exec 2>&1\n${command}`], env, cwd: this.state.cwd, onText: (l) => write(t.dim(l)) });
    this.startRun('shell', handle);
    this.render();
    const res = await handle.promise;
    this.endRun();
    if (res.code) this.print(t.dim(`    exit ${res.code}`));
  }
}

export async function runTui(ctx, cli) {
  if (!which('sh', ctx.env.PATH) && !fs.existsSync('/bin/sh')) throw new CosmoError('No /bin/sh found.');
  const app = new App(ctx, cli);
  return app.start();
}
