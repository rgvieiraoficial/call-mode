// Shared pieces for the hook and the status line badge: where things live,
// the user's config, and the per-session state file.
// Rule of thumb for everything here: never throw, never trust what is on disk.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CallState {
  client: string;
  start: string; // ISO date
  warned?: boolean; // the "forgot to end the call?" question was already asked
}

export interface Config {
  rules: string[];
  onEnd: string;
  start: string[];
  end: string[];
  label: string;
  color: number; // 256-color palette index
  staleHours: number;
  locale?: string;
}

export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STATE_BYTES = 4096;
const MAX_CONFIG_BYTES = 16384;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Built from the char code so editors and tools cannot turn it into an invisible literal.
export const LEADING_BOM = new RegExp('^' + String.fromCharCode(0xfeff) + '+');

export const DEFAULT_CONFIG: Config = {
  rules: [
    "CALL MODE ACTIVE: the user's screen is being shared with a client. The client can read everything you write in the chat.",
    '- In the chat: only technical content the client may read.',
    "- NEVER in the chat: prices, rates, hours spent, budget, negotiation, opinions about the client, other clients, the user's personal matters.",
    '- Anything internal: keep it to yourself (do not say in the chat that you are holding notes) and include it in the summary after the call ends.',
    "- Need an internal decision? Ask neutrally: \"I have an organizational question for you, off-screen.\"",
  ],
  onEnd: 'The screen is private again: give a short summary of what you held back during the call (internal topics, time, pending decisions).',
  start: ['call mode'],
  end: ['end call'],
  label: 'CALL',
  color: 39,
  staleHours: 12,
};

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function stateDir(): string {
  return process.env.CALL_MODE_STATE_DIR || path.join(claudeDir(), 'state', 'call-mode');
}

export function configPath(): string {
  return process.env.CALL_MODE_CONFIG || path.join(claudeDir(), 'call-mode.json');
}

export function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(CONTROL, '').trim().slice(0, max);
}

// Reads a small regular file; refuses symlinks, other file types and oversized files.
function readSmallFile(file: string, maxBytes: number): string | null {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8').replace(LEADING_BOM, '');
  } catch {
    return null;
  }
}

function cleanList(value: unknown, maxItems: number, maxLen: number, pattern?: RegExp): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((v) => clean(v, maxLen))
    .filter((v) => v && (!pattern || pattern.test(v)))
    .slice(0, maxItems);
  return list.length ? list : null;
}

// Missing or broken config falls back to the defaults, field by field.
export function loadConfig(): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  const raw = readSmallFile(configPath(), MAX_CONFIG_BYTES);
  if (!raw) return config;
  let user: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return config;
    user = parsed as Record<string, unknown>;
  } catch {
    return config;
  }
  const marker = /^[\p{L}\p{N} _-]+$/u;
  config.rules = cleanList(user.rules, 40, 1000) ?? config.rules;
  config.start = cleanList(user.start, 5, 40, marker) ?? config.start;
  config.end = cleanList(user.end, 5, 40, marker) ?? config.end;
  if (typeof user.onEnd === 'string') config.onEnd = clean(user.onEnd, 1000);
  if (typeof user.label === 'string' && clean(user.label, 20)) config.label = clean(user.label, 20);
  if (Number.isInteger(user.color) && (user.color as number) >= 0 && (user.color as number) <= 255) {
    config.color = user.color as number;
  }
  if (typeof user.staleHours === 'number' && user.staleHours >= 0 && user.staleHours <= 720) {
    config.staleHours = user.staleHours;
  }
  if (typeof user.locale === 'string') {
    try {
      config.locale = Intl.DateTimeFormat.supportedLocalesOf([user.locale])[0];
    } catch {
      /* invalid locale: keep the system one */
    }
  }
  return config;
}

export function stateFile(sessionId: string): string {
  return path.join(stateDir(), `${sessionId}.json`);
}

export function readState(sessionId: string): CallState | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const raw = readSmallFile(stateFile(sessionId), MAX_STATE_BYTES);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const start = new Date(String(data?.start));
    if (Number.isNaN(start.getTime())) return null;
    const state: CallState = { client: clean(data.client, 40), start: start.toISOString() };
    if (data.warned === true) state.warned = true;
    return state;
  } catch {
    return null;
  }
}

// Creates the state folder if needed; refuses it when it is a symlink.
function safeDir(): boolean {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    return !fs.lstatSync(stateDir()).isSymbolicLink();
  } catch {
    return false;
  }
}

// Atomic write: temp file + rename, so a reader never sees half a file.
export function writeState(sessionId: string, state: CallState): boolean {
  if (!SESSION_ID.test(sessionId) || !safeDir()) return false;
  const file = stateFile(sessionId);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
  } catch {
    /* does not exist yet */
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(state));
    } finally {
      fs.closeSync(fd);
    }
    // On Windows a rename over a file another process is reading can fail; retry a little.
    for (let i = 0; i < 3; i++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch {
        /* retry */
      }
    }
  } catch {
    /* fall through to cleanup */
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* nothing to clean */
  }
  return false;
}

export function deleteState(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) return;
  const file = stateFile(sessionId);
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// Removes state older than 14 days and temp files left behind by a crash.
export function sweepOld(now: number): void {
  if (!safeDir()) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(stateDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!/\.(json|tmp)$/.test(name)) continue;
    const file = path.join(stateDir(), name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      const limit = name.endsWith('.tmp') ? 60_000 : 14 * 24 * 3600_000;
      if (now - st.mtimeMs > limit) fs.unlinkSync(file);
    } catch {
      /* skip */
    }
  }
}
