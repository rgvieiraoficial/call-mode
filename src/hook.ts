// UserPromptSubmit hook. "[call mode]" or "[call mode: Client]" turns call mode on for
// this session; "[end call]" turns it off and reports start, end and duration.
// While on, the rules are added to every prompt as context, so nothing depends on
// Claude remembering them. Always exits 0 and never blocks the prompt.
import { CallState, Config, LEADING_BOM, SESSION_ID, clean, deleteState, loadConfig, readState, sweepOld, writeState } from './core';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "call mode" also matches "[call-mode]", "[CALL_MODE]", "[ call  mode ]".
function markerPattern(phrases: string[], withName: boolean): RegExp {
  const words = phrases.map((p) => p.split(/[\s_-]+/).filter(Boolean).map(escapeRegExp).join('[\\s_-]+'));
  const name = withName ? '(?::\\s*([^\\]]+?))?' : '';
  return new RegExp(`\\[\\s*(?:${words.join('|')})\\s*${name}\\s*\\]`, 'i');
}

function clock(date: Date, config: Config): string {
  return new Intl.DateTimeFormat(config.locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function duration(ms: number): string {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}

// Plugin commands are namespaced by the plugin name: /call-mode:on and /call-mode:off.
// Claude Code hands them to hooks as an envelope:
//   <command-name>/call-mode:on</command-name> <command-args>Acme</command-args>
// The plain "/call-mode:on Acme" form is accepted too, and so is the 0.2 command
// (/call-mode or /call-mode:call-mode, where an off word in the args ends the call).
type Command = { kind: 'on' | 'off' | 'legacy'; args: string };

function commandKind(name: string): Command['kind'] | null {
  const m = /^\/(?:call-mode:(on|off|call-mode)|call-mode)$/i.exec(name);
  if (!m) return null;
  const sub = (m[1] || '').toLowerCase();
  return sub === 'on' ? 'on' : sub === 'off' ? 'off' : 'legacy';
}

function slashCommand(prompt: string): Command | null {
  const name = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(prompt);
  if (name) {
    const kind = commandKind(name[1]);
    if (!kind) return null;
    const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(prompt);
    return { kind, args: args ? args[1].trim() : '' };
  }
  const plain = /^\s*(\/\S+)(?:\s+([^\n]*))?\s*$/.exec(prompt);
  const kind = plain ? commandKind(plain[1]) : null;
  return kind ? { kind, args: (plain?.[2] || '').trim() } : null;
}

export interface Result {
  context?: string; // added to the prompt as context
}

export function handle(input: { prompt?: unknown; session_id?: unknown }, now = new Date()): Result {
  const prompt = String(input?.prompt ?? '');
  // Unattended scheduled runs are never in a call.
  if (/<scheduled-task\b/.test(prompt)) return {};
  const session = String(input?.session_id ?? '');
  if (!SESSION_ID.test(session)) return {};

  const config = loadConfig();
  const endTag = `[${config.end[0]}]`;
  let state: CallState | null = readState(session);
  const out: string[] = [];

  const command = slashCommand(prompt);
  const on = command ? null : prompt.match(markerPattern(config.start, true));
  const off = command
    ? command.kind === 'off' ||
      (command.kind === 'legacy' && config.commandOff.some((w) => w.toLowerCase() === command.args.toLowerCase()))
    : markerPattern(config.end, false).test(prompt);

  if (off) {
    if (!state) return { context: `The user ended call mode, but it was not on in this session.` };
    deleteState(session);
    const start = new Date(state.start);
    return {
      context:
        `CALL MODE OFF (${state.client || 'client'}). Call: ${clock(start, config)} to ${clock(now, config)} = ${duration(now.getTime() - start.getTime())}.\n` +
        config.onEnd,
    };
  }

  // "/call-mode:on [client]" or a start marker turns the mode on.
  // When the prompt is only that, Claude just confirms in one line (cheap, and
  // nothing odd on a shared screen; blocking the prompt would show a warning banner).
  if (command || on) {
    const client = clean(command ? command.args : on?.[1], 40);
    const only = Boolean(command) || on?.[0] === prompt.trim();
    if (!state) {
      sweepOld(now.getTime());
      state = { client, start: now.toISOString() };
      if (!writeState(session, state)) {
        out.push('WARNING: could not save call mode state (the status line badge will not show). The rules still apply to this message; ask the user to turn call mode on again.');
      }
      out.push(`CALL MODE ON now (${clock(now, config)})${client ? ` with ${client}` : ''}. Active until the user sends /call-mode:off or ${endTag}.`);
      if (only) out.push(`This prompt only turned call mode on: reply with one short line confirming it (e.g. "Call mode on at ${clock(now, config)}${client ? ` with ${client}` : ''}."), nothing else.`);
    } else {
      if (client && !state.client) {
        state.client = client;
        writeState(session, state);
      }
      if (only) out.push('Call mode was already on: reply with one short line saying so, nothing else.');
    }
  }

  if (state) {
    const start = new Date(state.start);
    const who = state.client ? ` Client on screen: ${state.client}.` : '';
    out.push(`${config.rules.join('\n')}\n(On since ${clock(start, config)}.${who})`);
    const elapsed = now.getTime() - start.getTime();
    // Asked once per call: the flag lives in the state file, not in Claude's memory.
    if (config.staleHours > 0 && elapsed > config.staleHours * 3600_000 && !state.warned) {
      state.warned = true;
      writeState(session, state);
      out.push(`Note: call mode has been on for ${duration(elapsed)}; the user may have forgotten ${endTag}. Ask once, neutrally, whether the call is still going.`);
    }
  }
  return out.length ? { context: out.join('\n') } : {};
}

function main(): void {
  let input = '';
  let done = false;
  const exit = () => process.exit(0);
  // Give up after 2 s if the host never sends a complete payload.
  const watchdog = setTimeout(exit, 2000);

  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    let result: Result = {};
    try {
      result = handle(JSON.parse(input.replace(LEADING_BOM, '')));
    } catch {
      result = {};
    }
    if (!result.context) return exit();
    const payload = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.context },
    });
    try {
      process.stdout.write(payload + '\n', exit);
    } catch {
      exit();
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    // Act on the first complete JSON instead of waiting for EOF (it can lag on Windows).
    try {
      JSON.parse(input.replace(LEADING_BOM, ''));
    } catch {
      return;
    }
    process.stdin.pause();
    try {
      process.stdin.unref();
    } catch {
      /* older Node */
    }
    run();
  });
  process.stdin.on('end', run);
  process.stdin.on('error', exit);
  process.stdout.on('error', exit);
  process.stderr.on('error', exit);
  process.on('uncaughtException', exit);
}

if (require.main === module) main();
