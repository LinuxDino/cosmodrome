import fs from 'node:fs';
import path from 'node:path';

/** Default fallback order when a provider hits a usage/quota limit. */
export const DEFAULT_PRIORITY = ['claude', 'codex', 'agy', 'copilot', 'opencode', 'ollama'];

const RATE_LIMIT_RE =
  /rate[ _-]?limit|usage[ _-]?limit|quota[ _-]?(exceeded|reached)|too many requests|\b429\b|credit balance|out of credits|overloaded|capacity|try again in \d+|billing|exhausted/i;

/**
 * Detect whether a failed (or warning) agent run hit a provider usage, rate, or quota limit.
 */
export function isUsageLimit({ code, stderr = '', text = '', result = null } = {}) {
  const combined = `${stderr}\n${ result?.result || '' }\n${text}`;
  if (RATE_LIMIT_RE.test(combined)) return true;
  if (code && /limit|quota|429/i.test(combined)) return true;
  return false;
}

/**
 * Tracks per-profile, per-agent usage, costs, and rate-limit cooldowns so cosmodrome
 * can silently switch to another healthy provider when one hits a usage limit.
 */
export class UsageTracker {
  constructor(filePath = null, { cooldownMs = 10 * 60 * 1000 } = {}) {
    this.filePath = filePath;
    this.cooldownMs = cooldownMs;
    this.stats = {};
    this.failovers = [];
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (data && typeof data.stats === 'object') this.stats = data.stats;
    } catch {
      /* fresh usage state */
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.filePath, JSON.stringify({ stats: this.stats, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  key(profile, agent) {
    return `${profile || 'default'}/${agent}`;
  }

  entry(profile, agent) {
    const k = this.key(profile, agent);
    if (!this.stats[k]) {
      this.stats[k] = {
        profile: profile || 'default',
        agent,
        runs: 0,
        errors: 0,
        rateLimits: 0,
        costUsd: 0,
        durationMs: 0,
        throttledUntil: 0,
        lastUsedAt: 0,
        lastReason: null,
      };
    }
    return this.stats[k];
  }

  isThrottled(profile, agent, now = Date.now()) {
    const e = this.stats[this.key(profile, agent)];
    return Boolean(e && e.throttledUntil > now);
  }

  remainingCooldownSecs(profile, agent, now = Date.now()) {
    const e = this.stats[this.key(profile, agent)];
    if (!e || e.throttledUntil <= now) return 0;
    return Math.ceil((e.throttledUntil - now) / 1000);
  }

  record(profile, agent, res = {}, durationMs = 0) {
    const e = this.entry(profile, agent);
    const now = Date.now();
    e.runs++;
    e.lastUsedAt = now;
    e.durationMs += res.result?.duration_ms || durationMs || 0;
    if (res.result?.total_cost_usd) e.costUsd += Number(res.result.total_cost_usd) || 0;

    const limited = isUsageLimit(res);
    if (limited) {
      e.rateLimits++;
      e.throttledUntil = now + this.cooldownMs;
      e.lastReason = 'usage limit';
    } else if (res.code && !res.cancelled) {
      e.errors++;
    } else if (res.code === 0) {
      e.throttledUntil = 0;
      e.lastReason = null;
    }
    this.save();
    return { limited, entry: e };
  }

  markThrottled(profile, agent, reason = 'usage limit', durationMs = this.cooldownMs) {
    const e = this.entry(profile, agent);
    e.rateLimits++;
    e.throttledUntil = Date.now() + durationMs;
    e.lastReason = reason;
    this.save();
  }

  recordFailover({ profile, from, to, reason = 'usage limit' }) {
    this.failovers.push({ profile, from, to, reason, at: Date.now() });
    if (this.failovers.length > 25) this.failovers.shift();
  }

  clearCooldowns() {
    for (const e of Object.values(this.stats)) {
      e.throttledUntil = 0;
      e.lastReason = null;
    }
    this.save();
  }

  /**
   * Pick the best healthy agent for a profile. If `preferred` is throttled or in `exclude`,
   * silently falls back to the next installed & healthy agent in priority order.
   */
  pickAgent({ profile, preferred, candidates = DEFAULT_PRIORITY, isInstalled = () => true, exclude = new Set(), now = Date.now() }) {
    const tried = new Set(exclude);
    if (preferred && !tried.has(preferred) && isInstalled(preferred) && !this.isThrottled(profile, preferred, now)) {
      return { agent: preferred, switched: false, from: null };
    }
    const order = [...new Set([...(preferred ? [preferred] : []), ...candidates])];
    for (const candidate of order) {
      if (tried.has(candidate)) continue;
      if (!isInstalled(candidate)) continue;
      if (this.isThrottled(profile, candidate, now)) continue;
      return {
        agent: candidate,
        switched: Boolean(preferred && candidate !== preferred),
        from: preferred || null,
        reason: preferred && this.isThrottled(profile, preferred, now) ? 'cooldown' : 'unavailable',
      };
    }
    return { agent: preferred || candidates[0], switched: false, from: null };
  }

  rows(profile = null, now = Date.now()) {
    return Object.values(this.stats)
      .filter((e) => !profile || e.profile === profile)
      .sort((a, b) => b.runs - a.runs)
      .map((e) => ({
        ...e,
        throttled: e.throttledUntil > now,
        cooldownSecs: Math.max(0, Math.ceil((e.throttledUntil - now) / 1000)),
      }));
  }
}
