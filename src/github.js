import fs from 'node:fs';
import path from 'node:path';

/**
 * Read the signed-in GitHub user for a host from gh's hosts.yml (offline, no API call).
 * Returns null if this profile has not signed in yet.
 */
export function readGhUser(ghConfigDir, host = 'github.com') {
  let text;
  try {
    text = fs.readFileSync(path.join(ghConfigDir, 'hosts.yml'), 'utf8');
  } catch {
    return null;
  }
  let inHost = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inHost = line.replace(/["']/g, '').replace(/:\s*$/, '').trim() === host;
      continue;
    }
    if (inHost) {
      const m = line.match(/^\s+user:\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) return m[1];
    }
  }
  return null;
}
