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

export function handle(input: { prompt?: unknown; session_id?: unknown }, now = new Date()): string {
  const prompt = String(input?.prompt ?? '');
  // Unattended scheduled runs are never in a call.
  if (/<scheduled-task\b/.test(prompt)) return '';
  const session = String(input?.session_id ?? '');
  if (!SESSION_ID.test(session)) return '';

  const config = loadConfig();
  const endTag = `[${config.end[0]}]`;
  let state: CallState | null = readState(session);
  const out: string[] = [];

  const on = prompt.match(markerPattern(config.start, true));
  const off = markerPattern(config.end, false).test(prompt);

  if (off) {
    if (!state) return `The user sent ${endTag}, but call mode was not on in this session.`;
    deleteState(session);
    const start = new Date(state.start);
    return (
      `CALL MODE OFF (${state.client || 'client'}). Call: ${clock(start, config)} to ${clock(now, config)} = ${duration(now.getTime() - start.getTime())}.\n` +
      config.onEnd
    );
  }

  if (on) {
    const client = clean(on[1], 40);
    if (!state) {
      sweepOld(now.getTime());
      state = { client, start: now.toISOString() };
      if (!writeState(session, state)) {
        out.push('WARNING: could not save call mode state (the status line badge will not show). The rules still apply to this message; ask the user to send the start marker again.');
      }
      out.push(`CALL MODE ON now (${clock(now, config)})${client ? ` with ${client}` : ''}. Active until the user sends ${endTag}.`);
    } else if (client && !state.client) {
      state.client = client;
      writeState(session, state);
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
  return out.join('\n');
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
    let text = '';
    try {
      text = handle(JSON.parse(input.replace(LEADING_BOM, '')));
    } catch {
      text = '';
    }
    if (!text) return exit();
    const payload = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
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
