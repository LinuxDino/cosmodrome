import fs from 'node:fs';
import path from 'node:path';
import { createZip, dirEntries } from './zip.js';

const EXT = {
  js: 'js', javascript: 'js', mjs: 'mjs', ts: 'ts', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', json: 'json', yaml: 'yml', yml: 'yml', md: 'md', markdown: 'md',
  html: 'html', css: 'css', go: 'go', rust: 'rs', rs: 'rs', java: 'java', sql: 'sql', toml: 'toml', ini: 'ini',
  xml: 'xml', svg: 'svg', csv: 'csv', ps1: 'ps1', powershell: 'ps1', dockerfile: 'Dockerfile', swift: 'swift', kotlin: 'kt',
};

function findUp(dir, name) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, name))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Inside a git repo: <repo>/.cosmo/artifacts (git-ignored). Elsewhere: the cosmodrome data folder. */
export function artifactsRoot(cwd, paths) {
  const repo = findUp(cwd, '.git');
  if (repo) return path.join(repo, '.cosmo', 'artifacts');
  return path.join(path.dirname(paths.stationDir), 'artifacts');
}

export function slugify(s, max = 40) {
  const slug = String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-');
  return slug.slice(0, max).replace(/-+$/, '') || 'artifact';
}

function safeRelPath(p) {
  const norm = path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.split('/').includes('..')) return null;
  return norm;
}

function filenameFromInfo(info) {
  for (const tok of info.split(/\s+/).filter(Boolean)) {
    const kv = tok.match(/^(?:file|filename|title|path)=["']?([^"']+)["']?$/);
    if (kv) return kv[1];
    if (/^[\w.-]*(?:\/[\w.-]+)*\.[\w-]+$/.test(tok) || /^\.[\w-]+$/.test(tok) || /^[\w.-]+\/[\w./-]+$/.test(tok)) return tok;
  }
  return null;
}

/** Pull fenced code blocks out of markdown as files. ```README.md / ```js src/app.js / ```js file=x.js */
export function extractFiles(markdown) {
  const files = [];
  const lines = String(markdown).split('\n');
  let open = null;
  let n = 0;
  for (const line of lines) {
    if (!open) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
      if (m) open = { fence: m[1], info: m[2].trim(), body: [] };
      continue;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      const lang = (open.info.split(/\s+/)[0] || '').toLowerCase();
      let name = filenameFromInfo(open.info);
      let body = open.body;
      const marker = body[0]?.match(/^\s*(?:\/\/|#|<!--|--)\s*file(?:name)?:\s*(\S+?)\s*(?:-->)?\s*$/i);
      if (!name && marker) {
        name = marker[1];
        body = body.slice(1);
      }
      name = name ? safeRelPath(name) : null;
      if (!name) name = `snippet-${++n}.${EXT[lang] || 'txt'}`;
      files.push({ path: name, content: body.join('\n') + '\n' });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return files;
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Save an agent answer as an artifact folder: the answer as markdown + every code block as a file. */
export function saveArtifact(root, { title, text, channel, prompt, kind = 'note' }) {
  fs.mkdirSync(root, { recursive: true });
  const cosmoDir = path.dirname(root);
  if (path.basename(cosmoDir) === '.cosmo' && !fs.existsSync(path.join(cosmoDir, '.gitignore'))) {
    fs.writeFileSync(path.join(cosmoDir, '.gitignore'), '*\n');
  }
  let dir = path.join(root, `${stamp()}-${slugify(title)}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${stamp()}-${slugify(title)}-${i}`);
  fs.mkdirSync(dir, { recursive: true });

  const mainName = kind === 'research' ? 'report.md' : 'RESPONSE.md';
  const files = [{ path: mainName, content: text.endsWith('\n') ? text : text + '\n' }];
  const taken = new Set([mainName]);
  for (const f of extractFiles(text)) {
    let p = f.path;
    for (let i = 2; taken.has(p); i++) p = f.path.replace(/(\.[^./]+)?$/, `-${i}$1`);
    taken.add(p);
    files.push({ path: p, content: f.content });
  }
  for (const f of files) {
    const abs = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  const meta = { title, kind, channel, prompt, createdAt: new Date().toISOString(), files: files.map((f) => f.path) };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { dir, files: meta.files };
}

/** Artifacts oldest first, so their numbers stay stable (#1 is the first one you saved). */
export function listArtifacts(root) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return names.map((name, i) => {
    const dir = path.join(root, name);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      /* folder without meta */
    }
    return { n: i + 1, name, dir, title: meta.title || name, kind: meta.kind || 'note', files: meta.files || [], createdAt: meta.createdAt };
  });
}

/** Zip one or more artifacts. Returns the zip path. */
export function zipArtifacts(root, artifacts, outName) {
  const entries = [];
  const single = artifacts.length === 1;
  for (const a of artifacts) entries.push(...dirEntries(a.dir, single ? slugify(a.title) : a.name, { exclude: ['meta.json'] }));
  const file = path.join(root, outName || (single ? `${artifacts[0].name}.zip` : `cosmo-artifacts-${stamp()}.zip`));
  fs.writeFileSync(file, createZip(entries));
  return { file, count: entries.length };
}
