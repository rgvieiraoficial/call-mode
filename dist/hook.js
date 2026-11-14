"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handle = handle;
// UserPromptSubmit hook. "[call mode]" or "[call mode: Client]" turns call mode on for
// this session; "[end call]" turns it off and reports start, end and duration.
// While on, the rules are added to every prompt as context, so nothing depends on
// Claude remembering them. Always exits 0 and never blocks the prompt.
const core_1 = require("./core");
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// "call mode" also matches "[call-mode]", "[CALL_MODE]", "[ call  mode ]".
function markerPattern(phrases, withName) {
    const words = phrases.map((p) => p.split(/[\s_-]+/).filter(Boolean).map(escapeRegExp).join('[\\s_-]+'));
    const name = withName ? '(?::\\s*([^\\]]+?))?' : '';
    return new RegExp(`\\[\\s*(?:${words.join('|')})\\s*${name}\\s*\\]`, 'i');
}
function clock(date, config) {
    return new Intl.DateTimeFormat(config.locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}
function duration(ms) {
    const total = Math.round(ms / 60000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}
// Claude Code hands slash commands to hooks as an envelope:
//   <command-name>/call-mode</command-name> <command-args>Acme</command-args>
// (plugin commands may also come namespaced as /call-mode:call-mode).
// The plain "/call-mode Acme" form is accepted too.
function slashCommand(prompt) {
    const name = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(prompt);
    if (name) {
        if (!/^\/(?:call-mode:)?call-mode$/i.test(name[1]))
            return null;
        const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(prompt);
        return { args: args ? args[1].trim() : '' };
    }
    const plain = /^\s*\/(?:call-mode:)?call-mode(?:\s+([^\n]*))?\s*$/i.exec(prompt);
    return plain ? { args: (plain[1] || '').trim() } : null;
}
function handle(input, now = new Date()) {
    const prompt = String(input?.prompt ?? '');
    // Unattended scheduled runs are never in a call.
    if (/<scheduled-task\b/.test(prompt))
        return {};
    const session = String(input?.session_id ?? '');
    if (!core_1.SESSION_ID.test(session))
        return {};
    const config = (0, core_1.loadConfig)();
    const endTag = `[${config.end[0]}]`;
    let state = (0, core_1.readState)(session);
    const out = [];
    const command = slashCommand(prompt);
    const on = command ? null : prompt.match(markerPattern(config.start, true));
    const off = command
        ? config.commandOff.some((w) => w.toLowerCase() === command.args.toLowerCase())
        : markerPattern(config.end, false).test(prompt);
    if (off) {
        if (!state)
            return { context: `The user ended call mode, but it was not on in this session.` };
        (0, core_1.deleteState)(session);
        const start = new Date(state.start);
        return {
            context: `CALL MODE OFF (${state.client || 'client'}). Call: ${clock(start, config)} to ${clock(now, config)} = ${duration(now.getTime() - start.getTime())}.\n` +
                config.onEnd,
        };
    }
    // "/call-mode [client]" or a start marker turns the mode on.
    // When the prompt is only that, Claude just confirms in one line (cheap, and
    // nothing odd on a shared screen; blocking the prompt would show a warning banner).
    if (command || on) {
        const client = (0, core_1.clean)(command ? command.args : on?.[1], 40);
        const only = Boolean(command) || on?.[0] === prompt.trim();
        if (!state) {
            (0, core_1.sweepOld)(now.getTime());
            state = { client, start: now.toISOString() };
            if (!(0, core_1.writeState)(session, state)) {
                out.push('WARNING: could not save call mode state (the status line badge will not show). The rules still apply to this message; ask the user to turn call mode on again.');
            }
            out.push(`CALL MODE ON now (${clock(now, config)})${client ? ` with ${client}` : ''}. Active until the user sends /call-mode ${config.commandOff[0]} or ${endTag}.`);
            if (only)
                out.push(`This prompt only turned call mode on: reply with one short line confirming it (e.g. "Call mode on at ${clock(now, config)}${client ? ` with ${client}` : ''}."), nothing else.`);
        }
        else {
            if (client && !state.client) {
                state.client = client;
                (0, core_1.writeState)(session, state);
            }
            if (only)
                out.push('Call mode was already on: reply with one short line saying so, nothing else.');
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
            (0, core_1.writeState)(session, state);
            out.push(`Note: call mode has been on for ${duration(elapsed)}; the user may have forgotten ${endTag}. Ask once, neutrally, whether the call is still going.`);
        }
    }
    return out.length ? { context: out.join('\n') } : {};
}
function main() {
    let input = '';
    let done = false;
    const exit = () => process.exit(0);
    // Give up after 2 s if the host never sends a complete payload.
    const watchdog = setTimeout(exit, 2000);
    const run = () => {
        if (done)
            return;
        done = true;
        clearTimeout(watchdog);
        let result = {};
        try {
            result = handle(JSON.parse(input.replace(core_1.LEADING_BOM, '')));
        }
        catch {
            result = {};
        }
        if (!result.context)
            return exit();
        const payload = JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.context },
        });
        try {
            process.stdout.write(payload + '\n', exit);
        }
        catch {
            exit();
        }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        input += chunk;
        // Act on the first complete JSON instead of waiting for EOF (it can lag on Windows).
        try {
            JSON.parse(input.replace(core_1.LEADING_BOM, ''));
        }
        catch {
            return;
        }
        process.stdin.pause();
        try {
            process.stdin.unref();
        }
        catch {
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
if (require.main === module)
    main();
