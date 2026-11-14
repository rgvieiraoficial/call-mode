# call-mode

A Claude Code plugin for when your screen is shared with a client.

Type `/call-mode Acme` and, until you type `/call-mode off`, every prompt you send carries a reminder to Claude: the client is reading the chat, so prices, hours, negotiation and other internal matters stay out of it. Claude holds them back and gives you a short summary when the call ends, together with the call's start, end and duration (taken from the clock, not from Claude's memory).

An optional status line badge shows `[CALL: Acme]` while the mode is on.

- **No network.** The plugin never makes a network call. No telemetry.
- **No dependencies** at runtime. Only Node.js (18+), which Claude Code already needs.
- **Per window.** Call mode in one Claude Code window does not turn it on in the others.
- **Your settings are never edited.** The status line badge is opt-in and set up by you.

## Install

Inside Claude Code:

```
/plugin marketplace add rgvieiraoficial/call-mode
/plugin install call-mode@yamirenato
```

That's it. Try it: send `/call-mode Test`, then any message, then `/call-mode off`.

## Usage

| You type | What happens |
|---|---|
| `/call-mode` | Call mode on. The rules ride along with every prompt from now on. |
| `/call-mode Acme` | Same, with the client's name (shown in the badge). |
| `/call-mode off` | Call mode off. Claude reports start, end, duration and a summary of what it held back. |

**Turning it on costs zero tokens.** The hook records the call and blocks that prompt, so the model is never called; you just see a confirmation line. Turning it off does go to the model, because only Claude can summarize what it held back.

Prefer typing in the chat? The markers work too: `[call mode]`, `[call mode: Acme]` and `[end call]` (hyphens, underscores and case don't matter: `[Call-Mode]`, `[end_call]`). A prompt that is *only* the start marker is blocked like the command; a marker inside a longer prompt turns the mode on and the prompt goes through.

If a call stays on for more than 12 hours, Claude asks once whether you forgot to end it.

## Configuration

Optional. Create `~/.claude/call-mode.json` (or `$CLAUDE_CONFIG_DIR/call-mode.json`). Any field you leave out keeps its default.

```json
{
  "start": ["call mode"],
  "end": ["end call"],
  "rules": [
    "CALL MODE ACTIVE: the user's screen is being shared with a client. The client can read everything you write in the chat.",
    "- NEVER in the chat: prices, rates, hours spent, budget, negotiation."
  ],
  "onEnd": "The screen is private again: give a short summary of what you held back during the call.",
  "label": "CALL",
  "color": 39,
  "staleHours": 12,
  "locale": "en-US"
}
```

| Field | Meaning |
|---|---|
| `start` / `end` | Marker phrases, without brackets. Letters, digits, spaces, `-` and `_` only. Up to 5 each. |
| `rules` | Lines sent to Claude on every prompt while the mode is on. Write them in your language. |
| `onEnd` | What Claude should do when the call ends. |
| `label` | Badge text (`[CALL: Acme]`). |
| `color` | Badge color, a 256-color palette index (0–255). |
| `staleHours` | Hours before the "forgot to end the call?" question. `0` turns it off. |
| `locale` | Format of the times shown (`pt-BR`, `en-GB`...). Defaults to your system's. |

A broken or oversized config file is ignored and the defaults are used.

A Brazilian Portuguese example is in [`examples/call-mode.pt-BR.json`](examples/call-mode.pt-BR.json).

## Status line badge

Plugins can't set up a status line, so this part is manual. Clone the repo somewhere stable (the plugin's own install folder changes on every update):

```
git clone https://github.com/rgvieiraoficial/call-mode ~/call-mode
```

**No status line yet?** Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/call-mode/dist/statusline.js"
  }
}
```

**Already have one?** Keep it, and put the badge in front with `--then`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/call-mode/dist/statusline.js --then \"your current status line command\""
  }
}
```

Your command gets the same input it always did; its output is shown after the badge. On Windows, use the full path (`C:/Users/you/call-mode/dist/statusline.js`).

## Limitations

- `UserPromptSubmit` hooks don't run in the VS Code / Cursor extension (a known Claude Code issue). Use the terminal.
- The rules are a strong reminder, not a filter: Claude follows them, but nothing blocks text from reaching the screen. Keep an eye on it.

## How it works

- `dist/hook.js` is a `UserPromptSubmit` hook. On `/call-mode` or a start marker it writes `{ client, start }` to `~/.claude/state/call-mode/<session_id>.json` (and blocks the prompt when it was only the command or the marker); while that file exists it adds the rules as `additionalContext`; on `/call-mode off` or the end marker it deletes the file and reports the duration. `commands/call-mode.md` only exists so `/call-mode` shows up in the command menu; the hook does the work.
- `dist/statusline.js` reads the same file, using the `session_id` Claude Code sends on stdin.
- The hook always exits 0 and gives up after 2 seconds, so it can never block your prompt. Session ids are validated before becoming file names, state is written atomically with `0600` permissions, symlinks are refused, and text from disk is stripped of control characters before it reaches your terminal. When a call starts, state older than 14 days is cleaned up.

## Uninstall

```
/plugin uninstall call-mode@yamirenato
```

Then remove the `statusLine` entry if you added one, and delete `~/.claude/state/call-mode/` and `~/.claude/call-mode.json`.

## Development

```
npm install
npm test
```

Source is TypeScript in `src/`. The compiled `dist/` is committed, because the plugin runs straight from the repo. Run `npm run check:dist` before committing to make sure `dist/` matches `src/`.

## License

MIT
