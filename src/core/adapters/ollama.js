import { createRun } from './base.js';

/**
 * Ollama through its HTTP API (`POST /api/chat`, stream: true) with global fetch - no CLI,
 * so no spinner or ANSI noise. Checked against Ollama 0.40.2.
 * Ollama keeps no conversation on the server; follow-ups get the earlier turns again
 * (kept in memory per session id, so `resume` works within one cosmo process).
 */
export const DEFAULT_OLLAMA_MODEL = 'qwen3:8b';
const histories = new Map();
const MAX_TURNS = 20;

export function ollamaHost(env = process.env) {
  let h = String(env.OLLAMA_HOST || '').trim();
  if (!h) return 'http://127.0.0.1:11434';
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
}

/** One-shot chat call (no streaming), e.g. for the planner. Returns the parsed response body. */
export async function ollamaChat({ env = process.env, model, messages, format, signal, fetchFn = globalThis.fetch, timeoutMs = 120000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener?.('abort', () => ctrl.abort());
  try {
    const res = await fetchFn(`${ollamaHost(env)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || DEFAULT_OLLAMA_MODEL, messages, stream: false, think: false, ...(format ? { format } : {}) }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `Ollama answered ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const ollama = {
  name: 'ollama',
  checkedWith: 'Ollama 0.40.2 HTTP API',
  capabilities: () => ({ structured: true, streaming: true, resume: true, readOnlyMode: true }),
  /** Parser for /api/chat NDJSON lines (also used to replay fixtures). */
  createParser() {
    const parser = {
      answer: '',
      line(line, run) {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        const piece = ev.message?.content || '';
        if (piece) {
          parser.answer += piece;
          run.text(piece);
        }
        if (ev.done) run.usage({ inputTokens: ev.prompt_eval_count, outputTokens: ev.eval_count, durationMs: ev.total_duration ? Math.round(ev.total_duration / 1e6) : undefined });
      },
    };
    return parser;
  },
  run(opts) {
    const { prompt, profileEnv, onEvent, mode = 'ask', role = 'main', runId, extra, } = opts;
    const fetchFn = opts.fetchFn || globalThis.fetch;
    const model = opts.model || DEFAULT_OLLAMA_MODEL;
    const run = createRun({ agent: 'ollama', mode, prompt: opts.displayPrompt ?? prompt, role, onEvent, runId, extra });
    const ctrl = new AbortController();
    let cancelled = false;
    run.start();
    const sessionId = opts.sessionId && histories.has(opts.sessionId) ? opts.sessionId : `ollama-${run.runId}`;
    const history = histories.get(sessionId) || [];
    const messages = [...history, { role: 'user', content: prompt }];

    const promise = (async () => {
      let answer = '';
      try {
        const res = await fetchFn(`${ollamaHost(profileEnv)}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true, think: false }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          let msg = body;
          try {
            msg = JSON.parse(body).error || body;
          } catch {
            /* plain text */
          }
          run.error(msg || `Ollama answered ${res.status}`, res.status === 404 ? 'other' : undefined);
          return run.finish({ code: 1 });
        }
        let buf = '';
        const decoder = new TextDecoder();
        const parser = ollama.createParser();
        const handle = (line) => {
          parser.line(line, run);
          answer = parser.answer;
        };
        for await (const chunk of res.body) {
          buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            handle(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        }
        handle(buf);
        run.session(sessionId);
        histories.set(sessionId, [...messages, { role: 'assistant', content: answer }].slice(-MAX_TURNS * 2));
        return run.finish({ code: 0 });
      } catch (err) {
        if (cancelled) return run.finish({ code: 130, cancelled: true });
        const refused = err?.cause?.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED/.test(String(err?.message));
        run.error(refused ? `Ollama is not running at ${ollamaHost(profileEnv)} (start it with: ollama serve)` : String(err?.message || err), refused ? 'crash' : undefined);
        return run.finish({ code: 1 });
      }
    })();

    const cancel = () => {
      cancelled = true;
      run.cancelRequested();
      ctrl.abort();
    };
    return { promise, cancel, signal: cancel, runId: run.runId };
  },
};
