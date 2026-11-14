const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, hook, statusline } = require('./helpers');

const ESC = String.fromCharCode(27);

test('shows nothing when call mode is off or the id is invalid', () => {
  const s = sandbox();
  assert.equal(statusline({ session_id: 'none-1' }, s.env), '');
  assert.equal(statusline({ session_id: '../x' }, s.env), '');
  assert.equal(statusline('not json', s.env), '');
});

test('shows the badge with the client name in blue by default', () => {
  const s = sandbox();
  hook({ session_id: 'b-1', prompt: '[call mode: Acme]' }, s.env);
  assert.equal(statusline({ session_id: 'b-1' }, s.env), `${ESC}[38;5;39m[CALL: Acme]${ESC}[0m`);
});

test('uses label and color from the config', () => {
  const s = sandbox();
  fs.writeFileSync(s.configFile, JSON.stringify({ label: 'LIVE', color: 196 }));
  hook({ session_id: 'b-2', prompt: '[call mode]' }, s.env);
  assert.equal(statusline({ session_id: 'b-2' }, s.env), `${ESC}[38;5;196m[LIVE]${ESC}[0m`);
});

test('never prints control characters from a tampered state file', () => {
  const s = sandbox();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const client = `X${ESC}]8;;http://evil${String.fromCharCode(7)}Y`;
  fs.writeFileSync(path.join(s.stateDir, 't-1.json'), JSON.stringify({ client, start: new Date().toISOString() }));
  const out = statusline({ session_id: 't-1' }, s.env);
  assert.equal(out, `${ESC}[38;5;39m[CALL: X]8;;http://evilY]${ESC}[0m`);
});

test('--then runs the existing status line with the same stdin, after the badge', () => {
  const s = sandbox();
  hook({ session_id: 'w-1', prompt: '[call mode: Acme]' }, s.env);
  const other = `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`;
  const out = statusline({ session_id: 'w-1' }, s.env, ['--then', other]);
  assert.ok(out.startsWith(`${ESC}[38;5;39m[CALL: Acme]${ESC}[0m `), out);
  assert.match(out, /"session_id":"w-1"/);
});

test('--then still shows the other status line when call mode is off', () => {
  const s = sandbox();
  const other = `"${process.execPath}" -e "process.stdout.write('model: x')"`;
  assert.equal(statusline({ session_id: 'w-2' }, s.env, ['--then', other]), 'model: x');
});
