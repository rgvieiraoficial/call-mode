"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.badge = badge;
// Status line badge: prints "[CALL: Client]" while call mode is on in this window.
//   node statusline.js                       -> badge only
//   node statusline.js --then "<command>"    -> badge, then your existing status line
// With --then, the session JSON is passed to your command on stdin, unchanged.
const node_child_process_1 = require("node:child_process");
const core_1 = require("./core");
function badge(payload) {
    const session = String(payload?.session_id ?? '');
    const state = (0, core_1.readState)(session); // validates the id and the file
    if (!state)
        return '';
    const config = (0, core_1.loadConfig)();
    const text = state.client ? `[${config.label}: ${state.client}]` : `[${config.label}]`;
    return `\x1b[38;5;${config.color}m${text}\x1b[0m`;
}
function readStdin(timeoutMs) {
    return new Promise((resolve) => {
        if (process.stdin.isTTY)
            return resolve('');
        let data = '';
        const finish = () => {
            clearTimeout(timer);
            try {
                process.stdin.pause();
                process.stdin.unref();
            }
            catch {
                /* ignore */
            }
            resolve(data);
        };
        const timer = setTimeout(finish, timeoutMs);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', finish);
        process.stdin.on('error', finish);
    });
}
async function main() {
    const raw = (await readStdin(1000)).replace(core_1.LEADING_BOM, '');
    let payload = {};
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    }
    catch {
        payload = {};
    }
    const parts = [];
    try {
        parts.push(badge(payload));
    }
    catch {
        /* no badge */
    }
    const i = process.argv.indexOf('--then');
    const command = i >= 0 ? process.argv[i + 1] : undefined;
    if (command) {
        try {
            const result = (0, node_child_process_1.spawnSync)(command, { shell: true, input: raw, encoding: 'utf8', timeout: 5000 });
            parts.push((result.stdout || '').replace(/[\r\n]+$/, ''));
        }
        catch {
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
