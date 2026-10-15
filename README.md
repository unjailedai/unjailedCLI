<p align="center"><img src="logo.svg" width="96" alt="Unjailed AI"></p>

<h1 align="center">Unjailed CLI</h1>

<p align="center">Chat with <a href="https://unjailedai.com">Unjailed AI</a> from your terminal. It streams responses, renders markdown in clean boxes, runs an agent toolkit, tracks your token usage, and sends no telemetry.</p>

## Install

<!-- install:start -->

### macOS and Linux

```sh
curl -fsSL https://unjailedai.com/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://unjailedai.com/install.ps1 | iex
```

### npm (any OS)

```sh
npm install -g unjailed
```

You need **Node.js 20 or newer**. The install scripts check your Node version and then run `npm install -g unjailed` for you.

<!-- install:end -->

## Quick start

```sh
unjailed
```

Then type `/login` and paste your API key. You can get a key at [unjailedai.com/dashboard](https://unjailedai.com/dashboard). Once you're logged in, start chatting.

## Commands

Type `/` to open the command menu. Use ↑/↓ to move, Enter or Tab to select, and Esc to close.

| Command | What it does |
|---|---|
| `/login` | Paste your API key (input is masked). The key is checked against the API before it's saved. |
| `/logout` | Remove the saved API key. |
| `/model` | Pick a model from the live list. The current model is marked. Your chat history is kept when you switch, and your choice is remembered. |
| `/model <id>` | Switch straight to a model by its id. |
| `/effort` | Set reasoning effort: `auto` (default; the model decides), `low`, `medium` or `high`. `/effort high` sets it directly. Remembered between runs. |
| `/skills` | Switch skills on or off for this chat (Space toggles). `/skills <name>` toggles one; `/skills new <name>` creates one. |
| `/tools` | Choose permissions from a menu: read-only, file changes/commands with confirmations, automatic tools, or off. `/tools cmds` directly enables confirmed changes and commands. |
| `/api` | Show the base URL, masked key and current model, and run a live connection check. |
| `/remember [text\|clear]` | Pin an important instruction for this session. No argument shows your notes; `clear` removes them. Saved notes return with `/resume`. |
| `/context` | Show token usage for this chat: current context size, the last turn's prompt/completion tokens, message count and model. Numbers come from the API (or a `~` estimate if the server sends none). The context size also shows live in the status line as `ctx 12.4k`. |
| `/fun` | Toggle the fun effects — the startup wink, side snow and finish sparkle. `/fun off` turns them off; the choice is saved. Effects are off automatically when output is piped, `NO_COLOR` is set, or the terminal is small. |
| `/update` | Update the CLI to the latest version from npm. |
| `/auto` (`/bypass`) | Auto-approve enabled tools. In read/off mode it opens the permission picker; access changes only after your selection. `/auto off` restores confirmations, including when automatic tools were selected. Plan approvals still apply when plan mode is on. |
| `/plan` | Off on every startup, including upgrades with an old saved setting. `/plan on` requests a plan and approval for the next task only. `/plan off` cancels it. File and command permissions still apply. |
| `/resume` | Pick up a previous chat from the current folder. `/resume 2` or `/resume <id>` jumps straight to one. |
| `/sessions` | Browse saved chats from every folder: resume one, or press `d` to delete it. |
| `/clear` | Start a new chat and clear the screen. The previous chat stays saved. |
| `/help` | List commands and keyboard shortcuts. |
| `/exit` | Quit. Ctrl+C twice or Ctrl+D also works. |

### Updating

`/update` checks npm once and installs only a verified published version newer than your running build. If your GitHub/local build is ahead of npm, it leaves the installation alone and explains the mismatch. A release floor is never treated as proof that a version has been published. Failed or malformed registry checks install nothing.

After any installation, exit and reopen the CLI. To resume the same chat, run `unjailed -c` from the same project folder. An already-open terminal keeps its previously loaded runtime even when a newer build is installed on disk.

The updater reports the exact installation target. A failed update never recommends an unpinned `@latest` fallback that could downgrade a GitHub build. On Windows, a failed installation restores the prior package directory when possible and retains backup files if restoration is blocked. POSIX npm commands run without a shell.

## Sessions

Chats are saved automatically after each reply, tagged with the folder you started `unjailed` in, so each project keeps its own history.

Long chats automatically shorten older **request context** to keep the terminal
and requests responsive. Requests target about 96,000 characters and 160 recent
messages; the initial task, system instructions, recent turns and complete live
tool-call/result groups are retained. These are targets: a large active tool
group or protected recent turn can exceed them. The CLI tells you when older
request text was shortened or omitted. Your full chat text stays in the current
session and in saved chats. The request now carries exact older requirements
and excerpts relevant to your latest prompt, rather than simply losing the
older window. In agent mode, the read-only `search_history` tool can search and
recover exact previous messages and tool results, including after `/resume`.
Recent tool evidence distinguishes completed actions from failed or skipped
ones. `/remember <instruction>` keeps your most important constraints in each
request; notes apply to this session and keep current tool permissions.
`/clear` starts a fresh task and keeps the previous saved chat available through
`/resume`.

Long code blocks and large pasted drafts use a bounded live viewport. The full
response prints when its block finishes; the full draft remains editable and
is submitted unchanged. Completed output stays in terminal scrollback without
being reformatted on every keypress. Saves append only new messages and tool
results, avoiding a full-history rewrite after every reply. Existing saved
chats migrate automatically on their next save.

While a turn runs, an animated status stays visible through waiting, reasoning,
writing, tool execution and permission prompts, including pauses after the first
response text. It shows elapsed time and the stop shortcut. Waiting indicates an
open request, not a guarantee that the server is making progress.

```sh
unjailed -c     # continue the most recent chat in this folder
unjailed -r     # choose a saved chat to resume
```

Inside the app, `/resume` lists this folder's chats and `/sessions` lists all of them. Sessions use a small JSON manifest and an append-only JSONL history in `~/.unjailed/sessions/` (permissions `600`); the newest 200 are kept. To turn saving off, set `UNJAILED_NO_HISTORY=1` or put `"saveSessions": false` in `config.json`.

## Skills

A skill is a markdown file of instructions the model follows while it's switched on: a coding style, a review checklist, a persona, house rules for a project.

| Where | Applies to |
|---|---|
| `./.unjailed/skills/<name>/SKILL.md` or `./.unjailed/skills/<name>.md` | This project (wins if a name clashes) |
| `~/.unjailed/skills/<name>/SKILL.md` or `~/.unjailed/skills/<name>.md` | Every folder |

```markdown
---
name: reviewer
description: Strict code review
---
Review code like a senior engineer. List bugs first, then style.
```

Switched-on skills are sent as a system message with each request and re-read from disk every time, so edits apply straight away. Saved chats remember which skills were on, and `/resume` switches them back on.

## Agent tools

`/tools` opens a permission picker for tools that act on your computer. Choose
file changes and commands to create folders, write programs and execute them;
you approve each action. It works on Linux, macOS and Windows.

| Mode | What the model can do |
|---|---|
| `/tools read` | **Read-only:** read files, list directories, glob-find files, grep contents, read clipboard, fetch web pages, inspect background jobs |
| `/tools cmds` | **+ write:** write/edit/move/delete files, launch apps, run commands — you confirm each action with `y` |
| `/tools yolo` | Same as `cmds`, changes and commands run without confirmation |
| `/tools off` | Plain chat (default) |

The toolkit:

| Tool | What it does |
|---|---|
| `read_file` | Read a file (200 KB cap) |
| `list_dir` | List a directory |
| `glob` | Find files by name pattern (`**/*.ts`) |
| `grep` | Search file contents, regex, file:line results |
| `open_url` | Open an http/https URL in your default browser (cmds/yolo) |
| `clipboard` | Read clipboard; writes require cmds/yolo |
| `launch_app` | Open an app or file with the OS (cmds/yolo) |
| `move_file` | Move/rename without overwriting an existing destination (cmds/yolo) |
| `delete_file` | Move to Trash; permanent deletion must be explicit (cmds/yolo) |
| `web_fetch` | Fetch a page/API and read it as text |
| `write_file` | Create or overwrite a file (cmds/yolo) |
| `edit_file` | Exact string replace in a file (cmds/yolo) |
| `run_command` | Shell with `cwd`, `timeout_ms` and `background` options (cmds/yolo) |
| `process_status` | Read a background job's status and recent output |
| `stop_process` | Stop a background job and its children (cmds/yolo) |

Commands run through `cmd /d /s /c` on Windows and `/bin/sh -c` elsewhere.
`run_command` accepts `cwd` so the agent can build and run projects anywhere your
OS account can access, including folders with spaces. All filesystem tools and
command directories support `~/` and `Desktop`, `Documents`, or `Downloads`
shortcuts. This is ordinary local-user access; OS permissions still apply.

In `/tools cmds`, file writes/edits/moves/deletes, clipboard writes, app launches
and commands require your approval. `/tools read` enforces read-only tools even
if a model requests an unlisted tool. `/auto` in read/off mode asks you to choose
access; cancel keeps the current permissions. `/tools cmds` always enables
confirmations, even if auto approval was previously active. `/tools yolo` or
`/auto` with enabled command tools skips per-action prompts by your choice;
`/auto off` restores them.
Tasks go directly to the agent/tool loop by default, without an extra planning request.
Old saved `plan: true` preferences no longer activate planning. `/plan on` arms
only the next task; approval, rejection, or a failed draft consumes it. Restarting
always clears it. A failed plan does not authorize tools. Planning never changes
file or command permissions.

Foreground commands default to a 10-minute timeout; `timeout_ms` can shorten it.
Cancellation and timeouts kill the command's process tree. Output retains a
bounded tail plus the exit status. For a development server, use
`background: true`; the returned `job_id` works with `process_status` and
`stop_process` during the current CLI session. Recent output is saved to
`.unjailed/bg-*.log` with a 100 KB disk cap. Job controls are not restored after
restarting the CLI. Use an OS service manager for persistent services.

Example: start with `/tools cmds`, then ask “Create a JavaScript app in my
Documents/demo folder, run it, and show me the output.” The agent can create,
edit, execute, inspect and fix the program, with approval for each change or
command. Use `/auto` only when you want those actions to run without prompts.

## Keys

| Key | Action |
|---|---|
| Enter | Send. If a reply is already streaming, your message is **queued** and runs as soon as the current one finishes (the status line shows how many are waiting). |
| Shift+Enter, or `\` then Enter | New line. Alt+Enter and Ctrl+J also work, for terminals that don't report Shift+Enter. |
| ↑ / ↓ | Step through your previous inputs |
| Paste | Multi-line pastes stay in the input box; they're never sent until you press Enter |
| Esc | Close menus. While a reply is running, press Esc **twice** to stop it and move on to the next queued prompt (the first press arms it, so a stray Esc won't kill a long reply). |
| Ctrl+C | Stops the response while one is streaming. Otherwise clears the input; press it twice to exit. |
| Ctrl+D | Exit |

## Environment variables

| Variable | Purpose |
|---|---|
| `UNJAILED_API_KEY` | API key. Takes priority over the saved key. |
| `UNJAILED_BASE_URL` | API base URL (default `https://unjailedai.com/v1`) |
| `UNJAILED_MODEL` | Model to start with |
| `UNJAILED_HOME` | Config directory (default `~/.unjailed`) |
| `UNJAILED_TIMEOUT` | Request/stream timeout in seconds (default 120 — reasoning models can think for a while before the first token) |
| `UNJAILED_REASONING_TIMEOUT` | Maximum time without answer/tool-argument progress (default 180 seconds; reasoning and heartbeats do not extend it) |
| `UNJAILED_RESPONSE_TIMEOUT` | Absolute time limit per model response (default 360 seconds; does not limit the whole task or local commands) |
| `UNJAILED_NO_HISTORY` | Set to `1` to stop saving chats (disables `/resume`) |
| `UNJAILED_NO_FX` | Set to `1` to turn off the fun effects (wink, snow, sparkle) |
| `NO_COLOR` | Turn off colors (also turns off the fun effects) |

## Config location

| OS | Path |
|---|---|
| macOS / Linux | `~/.unjailed/config.json` (permissions `600`) |
| Windows | `%USERPROFILE%\.unjailed\config.json` |

The file holds `apiKey`, `model`, an optional `baseUrl`, `saveSessions`, and `fx` (set `"fx": false` to disable the fun effects). Saved chats live next to it in `sessions/`. Delete it to reset everything. The CLI never prints your full key; it shows the key masked, for example `sk-…a1b2`.

## Privacy

The CLI sends no telemetry and no analytics, and makes no requests other than the API calls you trigger. Saved chat files stay on your machine in `~/.unjailed/sessions/`; request context and any history retrieved by the agent are sent to your configured API to answer your requests. Delete local histories with `/sessions` → `d`, delete the folder, or turn saving off with `UNJAILED_NO_HISTORY=1`.

## Development

```sh
npm install
npm run build     # compile TypeScript to dist/
npm run mock      # local mock API on http://localhost:8787/v1 (key: sk-mock-test-a1b2)
UNJAILED_BASE_URL=http://localhost:8787/v1 UNJAILED_HOME=./.dev node dist/index.js
npm test          # unit + integration tests against the mock
```

Put `ratelimit`, `servererror`, `credit`, `slow`, `hang`, `reason`, `markdown`, `longcode` or `usage` in a chat message to make the mock server return that behavior.

The default API URL is set in `src/constants.ts` (`DEFAULT_BASE_URL`).

## Minor bugs and limitations

- **Long-session rendering and memory (customer report, October 11, 2026):**
  addressed with incremental stream parsing, bounded live response/draft
  rendering, completed output outside Ink's growing static cache, async
  append-only saves, older exact excerpts and recoverable tool history.
  `/remember` pins critical instructions; `/context` shows request usage.
- Model/server latency and model reasoning accuracy still vary. Context is
  finite; automatic excerpts select relevant portions, and a model may need
  to use `search_history` for an older detail. Very large completed responses
  still take time proportional to the output they actually print. Saving
  opt-out means history remains available only until you close the CLI.

## License

MIT · [github.com/unjailedai/unjailedCLI](https://github.com/unjailedai/unjailedCLI)

### Coding reliability (0.12.5)

Update with `/update` or `npm install -g unjailed@latest`. Enable file and command access with `/tools cmds`; every change and command still asks for approval unless you explicitly enable automatic approval.

The CLI now continues when a model announces work without a tool call, with at most two recovery attempts and a clear failure message. It rejects incomplete tool arguments, preserves final streamed tool calls, supports line ranges in `read_file`, and preserves Windows CRLF and literal dollar characters in edits. Targeted edits and ranged reads support files up to 5 MB; individual full writes and replacements retain a 200 KB limit.

GLM 5.3 CLI requests default to low reasoning on the hosted API. `/effort high` remains available; the CLI's medium level maps to GLM's low level. A stream stops after 180 seconds without new answer/tool-argument progress, including after a short preamble. Reasoning, heartbeats and empty tool frames cannot extend that deadline. Each response also has a 360-second absolute ceiling. Completed changes remain on disk; incomplete timed-out calls do not execute. These deadlines apply per response, so a productive multi-step project can continue longer. Set `UNJAILED_REASONING_TIMEOUT` or `UNJAILED_RESPONSE_TIMEOUT` in seconds to override; `UNJAILED_TIMEOUT` controls header and idle timeouts (default 120 seconds).

Repeated identical failed file changes are blocked and returned to the model with instructions to read current text and correct its arguments. Three attempts at the same failed change stop the turn visibly. Requests release their abort listeners after completion, avoiding listener accumulation in long tool sessions. These are client fixes, not a guarantee that every model completes every project.

For Windows 10 coding: update, close and reopen the CLI, verify `unjailed --version`, then select `/tools cmds` and `/effort low`. If GLM Abliterated still stalls, try `/model deepseek-v4.1-flash` or `/model glm-5.3` on the same task. Third-party authenticated API clients can use the uncensored models too; the [OpenCode setup guide](https://unjailedai.com/docs#opencode) shows the existing API key and endpoint configuration. Local runtimes such as Python or Node must be installed for execution.


### Upgrade and stream recovery (0.12.7)

Planning is off on startup even if an older installation saved `plan: true`.
`/plan on` applies only to the next task and is consumed even if the draft fails
or is rejected. It does not change file or command permissions.

A known interrupted-stream error before any answer or tool-call fragment gets
one automatic retry. The same conversation and completed tool results are reused;
completed tools are not executed again. Partial answers or tool calls, unknown
errors, authentication failures and policy errors still stop visibly. No incomplete
tool call executes. Retry status is shown as activity, never as assistant output
or a fabricated completion. Source outages can still outlast this bounded recovery.

### Multi-round tool continuity and stalled-task recovery (0.12.8)

GLM tool turns now return the complete reasoning associated with completed tool
calls in the active task, as required by the model's interleaved-thinking
protocol. This context is held in memory only, never saved to chat/session files.
The hosted gateway forwards it without alteration. Missing, oversized or
over-budget chains fall back to cleared thinking as a whole; traces from old
tasks or restored sessions are never reconstructed or invented.

An actionable tool-enabled task that stalls before another tool call can now
continue once from its completed results, including after a short preamble.
The recovery request visibly uses low effort, at most 8,192 output tokens,
60 seconds without progress and a 120-second response ceiling. User-configured
shorter deadlines still apply. Normal effort resumes after that request.
Repeated completed mutations/commands requested in the recovery response return
their saved result instead of executing again. Fresh calls retain normal approval
checks. A second stall, partial tool call, denied permission, cancellation or
authorization/policy error stops; this is not an unlimited retry loop or a
guarantee that a slow source will finish every task. Usage remains billable under
normal API rates, including tokens actually generated before a cancellation.

### Live tool/code preview (0.12.9)

While a model streams a file change or command, the terminal shows a compact
`LIVE DRAFT` with the actual incoming code/arguments, target path and character
count. JSON escapes are decoded for readability. The preview is display only:
complete arguments and normal permission checks are still required before any
file or command action. Drafts are not appended to chat history or sent back to
the model, and rendering is batched with a bounded six-line preview.

Each action has a numbered description such as `Writing file` or `Running
command`. Waiting between rounds shows the last finished/stopped action and
`No new model output yet`; no generated code is invented during a silent wait.
The status timer resets for each request/phase/action, rather than displaying
the age of the entire task as if it were a single wait. This adds visibility;
it does not accelerate the model or add planning requests.

### Recovery for follow-up tasks and ordered progress (0.12.10)

Once tools have actually run in a turn, an ordinary follow-up such as "nothing
happens when I press the button" is eligible for the existing single bounded
stall recovery. Recovery no longer depends on that message containing an
English action keyword. A plain question without tool work remains a question;
declined permissions and incomplete tool responses still prevent automatic
recovery. A repeated stall now explicitly says a recovery was already attempted.

Each model response's progress text is printed before its matching action log,
including text without a trailing blank line. Separate rounds retain paragraph
boundaries in saved conversations instead of being glued into one long message.
These changes do not strip or reclassify model text as hidden reasoning, change
timeouts, replay completed commands or guarantee that a slow model will finish.
