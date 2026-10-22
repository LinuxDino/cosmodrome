# Event protocol

**protocolVersion: 1** (`PROTOCOL_VERSION` in `src/core/events.js`)

Everything cosmo does with agents is reported as a stream of plain JSON objects. The terminal
interface only renders these events; a future `cosmo daemon` (HTTP + SSE) and the apps will
consume the same stream. New optional fields can appear in any version; a field that changes
meaning or goes away bumps `protocolVersion`.

```js
import { CoreSession } from 'cosmodrome/src/core/session.js';
session.on('event', (ev) => { /* render */ });
await session.ask('explain src/env.js');
```

Inside the interface, modules get the same stream with `api.onEvent(fn)`.

## Common fields

| field | type | |
|---|---|---|
| `type` | string | one of the types below |
| `runId` | string | the agent run the event belongs to (step events use `step_<id>`) |
| `ts` | string | ISO time |
| `agent` | string | agent name, where it applies |
| `profile` | string | profile the run uses |
| `taskId` | string | task journal id (`src/tasks.js`), when the run belongs to a task |
| `stepId` | string | plan step, for runs started by a plan |

`validateEvent(ev)` returns a list of problems (empty when valid).

## Agent runs

| type | fields | meaning |
|---|---|---|
| `run_start` | `agent`, `mode` (`ask`/`auto`), `prompt`, `role` | an agent run started. `role`: `main` (stream it), `step` (part of a plan), `synthesis` (final answer of a plan; stream it), `planner` (hidden) |
| `text` | `text`, `final?` | answer text. Usually a delta: append it. `final: true` closes the current block (a message or paragraph); the next text starts a new one |
| `tool_start` | `toolId`, `name`, `detail` | the agent started a tool (only what the agent reports; never guessed from text) |
| `tool_end` | `toolId`, `ok`, `detail?` | the tool finished |
| `session` | `sessionId` | the agent's own conversation id; follow-ups resume it |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?`, `durationMs?`, `premiumRequests?`, `limitHit?` | whatever the agent reports |
| `error` | `message`, `kind` | `kind`: `limit` (usage/rate limit), `auth` (not signed in), `crash` (could not start / died), `parse` (unreadable output), `other` |
| `run_end` | `code`, `cancelled`, `text`, `sessionId`, `usage`, `limitHit`, `errorKind`, `toolCount`, `stderr` | the run finished; `text` is the full answer. An adapter's promise resolves with this same object |

Errors reported after an interrupt (Esc) are dropped; `run_end.cancelled` says what happened.

## Session

| type | fields | meaning |
|---|---|---|
| `failover` | `from`, `to`, `reason` (`usage limit`/`cooldown`), `role`, `stepId?` | an agent hit a usage limit or is on cooldown; the work moved to `to` |
| `notice` | `message`, `kind?` | something worth one line: a new conversation for this folder, the planner answer was not usable (`planner_fallback`), all agents on cooldown (`cooldown_wait`) |

## Plans

| type | fields | meaning |
|---|---|---|
| `plan` | `plan`, `source` (`ollama`/`claude`/`router`/`council`) | the validated plan that will run |
| `step_start` | `stepId`, `agent`, `mode`, `prompt` | a step started (its agent run follows with `role: step`, or `main` for a one-step plan) |
| `step_end` | `stepId`, `agent`, `status` (`done`/`error`/`cancelled`/`skipped`), `code` | a step finished; a step whose dependency failed is `skipped` |

A plan:

```json
{
  "kind": "delegate",
  "steps": [
    { "id": "s1", "agent": "codex", "mode": "ask", "prompt": "Find the failing test", "dependsOn": [] },
    { "id": "s2", "agent": "claude", "mode": "auto", "prompt": "Fix it", "dependsOn": ["s1"] }
  ],
  "synthesize": { "agent": "claude" }
}
```

`kind: "direct"` has exactly one step and no synthesis. Steps whose `dependsOn` are done run in
parallel; a step gets the results of the steps it depends on. A plan with several steps ends with
one synthesis run (`synthesize.agent`, else claude, else ollama, else the first step's agent).

## Example

```json
{"type":"run_start","runId":"run_m1","ts":"…","agent":"claude","profile":"work","mode":"ask","prompt":"read a.txt","role":"main"}
{"type":"session","runId":"run_m1","ts":"…","agent":"claude","sessionId":"1111…"}
{"type":"tool_start","runId":"run_m1","ts":"…","agent":"claude","toolId":"toolu_01","name":"Read","detail":"/work/a.txt"}
{"type":"tool_end","runId":"run_m1","ts":"…","agent":"claude","toolId":"toolu_01","ok":true}
{"type":"text","runId":"run_m1","ts":"…","agent":"claude","text":"hello"}
{"type":"text","runId":"run_m1","ts":"…","agent":"claude","text":"","final":true}
{"type":"usage","runId":"run_m1","ts":"…","agent":"claude","inputTokens":4,"outputTokens":132,"costUsd":0.0412,"durationMs":7400}
{"type":"run_end","runId":"run_m1","ts":"…","agent":"claude","code":0,"cancelled":false,"text":"hello","sessionId":"1111…","limitHit":false,"toolCount":1}
```
