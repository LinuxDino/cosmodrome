import { isUsageLimit } from '../usage.js';

/**
 * The event protocol every adapter, the executor and CoreSession emit. Bump PROTOCOL_VERSION
 * when a field changes meaning or goes away (adding optional fields is fine). See docs/protocol.md.
 */
export const PROTOCOL_VERSION = 1;

/** type -> required fields (besides type, runId, ts). Extra fields are allowed. */
export const EVENT_TYPES = {
  run_start: ['agent', 'mode', 'prompt'],
  text: ['text'],
  tool_start: ['toolId', 'name', 'detail'],
  tool_end: ['toolId', 'ok'],
  session: ['sessionId'],
  usage: [],
  error: ['message', 'kind'],
  run_end: ['code', 'cancelled', 'text'],
  plan: ['plan'],
  step_start: ['stepId'],
  step_end: ['stepId'],
  failover: ['from', 'to'],
  notice: ['message'],
};

export const ERROR_KINDS = ['limit', 'auth', 'crash', 'parse', 'other'];

/** What a run is for; the interface streams `main` and `synthesis`, and shows `step` runs as a tree. */
export const RUN_ROLES = ['main', 'step', 'synthesis', 'planner'];

const AUTH_RE = /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|please (?:log|sign) ?in|authenticat|missing (?:bearer|api key)|invalid api key|\/login\b/i;

export function makeEvent(type, fields = {}) {
  return { type, ts: new Date().toISOString(), ...fields };
}

/** Returns a list of problems; empty means the event is valid. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return ['event must be an object'];
  const required = EVENT_TYPES[ev.type];
  if (!required) return [`unknown event type "${ev.type}"`];
  const errors = [];
  if (typeof ev.ts !== 'string' || Number.isNaN(Date.parse(ev.ts))) errors.push('ts must be an ISO date string');
  if (!['plan', 'notice'].includes(ev.type) && typeof ev.runId !== 'string') errors.push('runId must be a string');
  for (const key of required) if (ev[key] === undefined) errors.push(`${ev.type}.${key} is missing`);
  if (ev.type === 'error' && !ERROR_KINDS.includes(ev.kind)) errors.push(`error.kind must be one of ${ERROR_KINDS.join(', ')}`);
  if (ev.type === 'text' && typeof ev.text !== 'string') errors.push('text.text must be a string');
  if (ev.type === 'run_start' && ev.role !== undefined && !RUN_ROLES.includes(ev.role)) errors.push(`run_start.role must be one of ${RUN_ROLES.join(', ')}`);
  return errors;
}

/** Sort a failure message into an error kind. Limit patterns are the ones usage.js uses. */
export function classifyError(message, { code = 1 } = {}) {
  const text = String(message || '');
  if (isUsageLimit({ code: code || 1, text })) return 'limit';
  if (AUTH_RE.test(text)) return 'auth';
  return 'other';
}

let counter = 0;
export function newRunId(prefix = 'run') {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}
