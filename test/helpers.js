// Runs the compiled scripts the way Claude Code does: JSON on stdin, read stdout.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const HOOK = path.join(DIST, 'hook.js');
const STATUSLINE = path.join(DIST, 'statusline.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-mode-test-'));
  const env = {
    ...process.env,
    CALL_MODE_STATE_DIR: path.join(dir, 'state'),
    CALL_MODE_CONFIG: path.join(dir, 'call-mode.json'),
  };
  return { dir, env, stateDir: env.CALL_MODE_STATE_DIR, configFile: env.CALL_MODE_CONFIG };
}

function run(script, input, env, args = []) {
  const stdin = typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [script, ...args], { input: stdin, env, encoding: 'utf8', timeout: 10000 });
  return { code: result.status, stdout: result.stdout || '' };
}

// Returns the additionalContext text, or '' when the hook printed nothing.
function hook(input, env) {
  const { code, stdout } = run(HOOK, input, env);
  if (code !== 0) throw new Error(`hook exited ${code}`);
  if (!stdout.trim()) return '';
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

function statusline(input, env, args) {
  const { code, stdout } = run(STATUSLINE, input, env, args);
  if (code !== 0) throw new Error(`statusline exited ${code}`);
  return stdout;
}

module.exports = { HOOK, STATUSLINE, sandbox, run, hook, statusline };
