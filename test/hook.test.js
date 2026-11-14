const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { HOOK, sandbox, hook, hookRaw, run } = require('./helpers');

const ESC = String.fromCharCode(27);
const BOM = String.fromCharCode(0xfeff);

test('turns on with a client name and saves the state', () => {
  const s = sandbox();
  const out = hook({ session_id: 'abc-1', prompt: '[call mode: Acme] hi' }, s.env);
  assert.match(out, /CALL MODE ON now/);
  assert.match(out, /Client on screen: Acme/);
  const state = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'abc-1.json'), 'utf8'));
  assert.equal(state.client, 'Acme');
});

test('repeats the rules on every prompt while on, only in that session', () => {
  const s = sandbox();
  hook({ session_id: 'abc-1', prompt: '[call mode]' }, s.env);
  assert.match(hook({ session_id: 'abc-1', prompt: 'next' }, s.env), /CALL MODE ACTIVE/);
  assert.equal(hook({ session_id: 'other-2', prompt: 'hi' }, s.env), '');
});

test('accepts hyphen, underscore and case variations of the markers', () => {
  const s = sandbox();
  assert.match(hook({ session_id: 'v-1', prompt: '[CALL_MODE] hi' }, s.env), /CALL MODE ON/);
  const out = hook({ session_id: 'v-1', prompt: '[end-call]' }, s.env);
  assert.match(out, /CALL MODE OFF/);
  assert.match(out, /= \d+min/);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'v-1.json')), false);
  assert.equal(hook({ session_id: 'v-1', prompt: 'after' }, s.env), '');
});

test('end marker without an active call says so', () => {
  const s = sandbox();
  assert.match(hook({ session_id: 'x-1', prompt: '[end call]' }, s.env), /was not on/);
});

test('ignores invalid or missing session ids and writes nothing', () => {
  const s = sandbox();
  assert.equal(hook({ session_id: '../x', prompt: '[call mode]' }, s.env), '');
  assert.equal(hook({ prompt: '[call mode]' }, s.env), '');
  assert.equal(fs.existsSync(s.stateDir), false);
});

test('broken JSON and empty input exit 0 silently', () => {
  const s = sandbox();
  for (const input of ['{"session_id":"abc', '']) {
    const { code, stdout } = run(HOOK, input, s.env);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  }
});

test('ignores scheduled tasks', () => {
  const s = sandbox();
  assert.equal(hook({ session_id: 's-1', prompt: '<scheduled-task x> [call mode]' }, s.env), '');
});

test('strips any number of leading BOMs (Windows PowerShell sends two)', () => {
  const s = sandbox();
  const input = BOM + BOM + JSON.stringify({ session_id: 'b-1', prompt: '[call mode: Bom]' });
  assert.match(hook(input, s.env), /with Bom/);
});

test('removes control characters from the client name', () => {
  const s = sandbox();
  hook({ session_id: 'c-1', prompt: `[call mode: Ac${ESC}[31mme]` }, s.env);
  const state = fs.readFileSync(path.join(s.stateDir, 'c-1.json'), 'utf8');
  assert.equal(state.includes(ESC), false);
});

test('rejects oversized state and an invalid start date', () => {
  const s = sandbox();
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.stateDir, 'big-1.json'), 'a'.repeat(5000));
  fs.writeFileSync(path.join(s.stateDir, 'bad-1.json'), JSON.stringify({ client: 'Z', start: 'nope' }));
  assert.equal(hook({ session_id: 'big-1', prompt: 'hi' }, s.env), '');
  assert.equal(hook({ session_id: 'bad-1', prompt: 'hi' }, s.env), '');
});

test('warns when a call looks forgotten', () => {
  const s = sandbox();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const start = new Date(Date.now() - 13 * 3600_000).toISOString();
  fs.writeFileSync(path.join(s.stateDir, 'old-1.json'), JSON.stringify({ client: '', start }));
  assert.match(hook({ session_id: 'old-1', prompt: 'hi' }, s.env), /may have forgotten/);
  // only once: the next prompts keep the rules but not the question
  const next = hook({ session_id: 'old-1', prompt: 'again' }, s.env);
  assert.match(next, /CALL MODE ACTIVE/);
  assert.doesNotMatch(next, /may have forgotten/);
});

test('sweeps state older than 14 days and stray temp files when a call starts', () => {
  const s = sandbox();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const old = path.join(s.stateDir, 'old.json');
  const tmp = path.join(s.stateDir, 'x.json.1.2.tmp');
  const recent = path.join(s.stateDir, 'recent.json');
  for (const f of [old, tmp, recent]) fs.writeFileSync(f, '{}');
  const ago = (ms) => new Date(Date.now() - ms);
  fs.utimesSync(old, ago(20 * 86400_000), ago(20 * 86400_000));
  fs.utimesSync(tmp, ago(5 * 60_000), ago(5 * 60_000));
  fs.utimesSync(recent, ago(86400_000), ago(86400_000));
  hook({ session_id: 'new-1', prompt: '[call mode]' }, s.env);
  assert.deepEqual(fs.readdirSync(s.stateDir).sort(), ['new-1.json', 'recent.json']);
});

test('refuses a symlinked state file', (t) => {
  const s = sandbox();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const target = path.join(s.dir, 'secret.json');
  fs.writeFileSync(target, JSON.stringify({ client: 'Secret', start: new Date().toISOString() }));
  try {
    fs.symlinkSync(target, path.join(s.stateDir, 'l-1.json'), 'file');
  } catch {
    t.skip('this system does not allow creating symlinks');
    return;
  }
  assert.equal(hook({ session_id: 'l-1', prompt: 'hi' }, s.env), '');
  assert.match(hook({ session_id: 'l-1', prompt: '[call mode]' }, s.env), /could not save/);
  assert.match(fs.readFileSync(target, 'utf8'), /Secret/);
});

function timeExit(chunk) {
  return new Promise((resolve) => {
    const s = sandbox();
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: s.env });
    child.stdin.write(chunk); // never closed
    child.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
  });
}

test('gives up after ~2 s when the payload never completes', async () => {
  const { code, ms } = await timeExit('{"session_id":"abc');
  assert.equal(code, 0);
  assert.ok(ms < 4000, `took ${ms} ms`);
});

test('does not wait for EOF once the JSON is complete', async () => {
  const { code, ms } = await timeExit(JSON.stringify({ session_id: 'f-1', prompt: 'hi' }));
  assert.equal(code, 0);
  assert.ok(ms < 1500, `took ${ms} ms`);
});

test('config: custom markers, rules and end text', () => {
  const s = sandbox();
  fs.writeFileSync(s.configFile, JSON.stringify({
    start: ['modo call'], end: ['fim call'], rules: ['REGRA X'], onEnd: 'RESUMO Y', locale: 'pt-BR',
  }));
  assert.match(hook({ session_id: 'k-1', prompt: '[modo-call: Ana] oi' }, s.env), /REGRA X/);
  assert.equal(hook({ session_id: 'k-2', prompt: '[call mode]' }, s.env), '');
  assert.match(hook({ session_id: 'k-1', prompt: '[fim call]' }, s.env), /RESUMO Y/);
});

const envelope = (name, args) =>
  `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`;

test('/call-mode turns on and blocks the prompt (no model call)', () => {
  const s = sandbox();
  for (const [id, prompt] of [
    ['e-1', envelope('/call-mode', 'Acme')],
    ['e-2', envelope('/call-mode:call-mode', 'Acme')],
    ['e-3', '/call-mode Acme'],
  ]) {
    const out = hookRaw({ session_id: id, prompt }, s.env);
    assert.equal(out.decision, 'block', id);
    assert.match(out.reason, /Call mode on .* with Acme/, id);
    assert.equal(out.hookSpecificOutput, undefined, id);
    const state = JSON.parse(fs.readFileSync(path.join(s.stateDir, `${id}.json`), 'utf8'));
    assert.equal(state.client, 'Acme', id);
  }
});

test('/call-mode without a name, and again while on', () => {
  const s = sandbox();
  assert.match(hookRaw({ session_id: 'n-1', prompt: envelope('/call-mode', '') }, s.env).reason, /Call mode on \(/);
  const again = hookRaw({ session_id: 'n-1', prompt: envelope('/call-mode', 'Acme') }, s.env);
  assert.equal(again.decision, 'block');
  assert.match(again.reason, /already on .*Acme/);
});

test('/call-mode off ends the call and goes to the model for the summary', () => {
  const s = sandbox();
  hook({ session_id: 'o-1', prompt: '/call-mode Acme' }, s.env);
  const out = hookRaw({ session_id: 'o-1', prompt: envelope('/call-mode', 'off') }, s.env);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /CALL MODE OFF \(Acme\)/);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'o-1.json')), false);
});

test('a prompt that is only the start marker is blocked; with text it is not', () => {
  const s = sandbox();
  assert.equal(hookRaw({ session_id: 'm-1', prompt: '  [call mode: Acme] ' }, s.env).decision, 'block');
  const out = hookRaw({ session_id: 'm-2', prompt: '[call mode: Acme] look at this bug' }, s.env);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /CALL MODE ON now/);
});

test('other slash commands are not mistaken for /call-mode', () => {
  const s = sandbox();
  assert.equal(hook({ session_id: 'z-1', prompt: envelope('/call-modes', 'x') }, s.env), '');
  assert.equal(hook({ session_id: 'z-1', prompt: '/call-mode-x' }, s.env), '');
  assert.equal(fs.existsSync(s.stateDir), false);
});

test('config: broken, oversized or wrongly typed config falls back to defaults', () => {
  const s = sandbox();
  for (const content of ['{nope', 'x'.repeat(20000), JSON.stringify({ rules: 'not a list', start: ['bad]marker'] })]) {
    fs.writeFileSync(s.configFile, content);
    assert.match(hook({ session_id: 'd-1', prompt: '[call mode] hi' }, s.env), /CALL MODE ACTIVE/);
    hook({ session_id: 'd-1', prompt: '[end call]' }, s.env);
  }
});
