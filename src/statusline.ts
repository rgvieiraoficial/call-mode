// Status line badge: prints "[CALL: Client]" while call mode is on in this window.
//   node statusline.js                       -> badge only
//   node statusline.js --then "<command>"    -> badge, then your existing status line
// With --then, the session JSON is passed to your command on stdin, unchanged.
import { spawnSync } from 'node:child_process';
import { LEADING_BOM, loadConfig, readState } from './core';

export function badge(payload: unknown): string {
  const session = String((payload as { session_id?: unknown })?.session_id ?? '');
  const state = readState(session); // validates the id and the file
  if (!state) return '';
  const config = loadConfig();
  const text = state.client ? `[${config.label}: ${state.client}]` : `[${config.label}]`;
  return `\x1b[38;5;${config.color}m${text}\x1b[0m`;
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const finish = () => {
      clearTimeout(timer);
      try {
        process.stdin.pause();
        process.stdin.unref();
      } catch {
        /* ignore */
      }
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main(): Promise<string> {
  const raw = (await readStdin(1000)).replace(LEADING_BOM, '');
  let payload: unknown = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const parts: string[] = [];
  try {
    parts.push(badge(payload));
  } catch {
    /* no badge */
  }

  const i = process.argv.indexOf('--then');
  const command = i >= 0 ? process.argv[i + 1] : undefined;
  if (command) {
    try {
      const result = spawnSync(command, { shell: true, input: raw, encoding: 'utf8', timeout: 5000 });
      parts.push((result.stdout || '').replace(/[\r\n]+$/, ''));
    } catch {
      /* the other status line failed; show the badge alone */
    }
  }

  return parts.filter(Boolean).join(' ');
}

if (require.main === module) {
  const exit = () => process.exit(0);
  process.stdout.on('error', exit);
  main()
    .then((line) => (line ? process.stdout.write(line, exit) : exit()))
    .catch(exit);
}
