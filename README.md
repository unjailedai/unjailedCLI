<p align="center"><img src="logo.svg" width="96" alt="Unjailed AI"></p>

<h1 align="center">Unjailed CLI</h1>

<p align="center">Chat with <a href="https://unjailedai.com">Unjailed AI</a> from your terminal. It streams responses, renders markdown cleanly, runs a coding agent with subagents and multi-agent workflows, keeps working toward goals and on loops, rides out outages, and sends no telemetry.</p>

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

You need **Node.js 20 or newer**. The install scripts check your Node version and then run `npm install -g unjailed@<version>` for you, pinned to the current release (0.12.4). Set `UNJAILED_VERSION` to install a different version, for example `curl -fsSL https://unjailedai.com/install.sh | UNJAILED_VERSION=0.12.4 sh`.

<!-- install:end -->

## Quick start

```sh
unjailed
```

Then type `/login` and paste your API key. You can get a key at [unjailedai.com/dashboard](https://unjailedai.com/dashboard). Once you're logged in, start chatting.

```sh
unjailed -c        # continue the most recent chat in this folder (--continue)
unjailed -r        # pick a saved chat to resume (--resume)
unjailed -v        # print the version (--version)
unjailed -h        # show usage, options and environment variables (--help)
```

Any other option exits with `Unknown option`. The CLI is interactive and exits if stdin is not a terminal.

## Commands

Type `/` to open the command menu. Use ↑/↓ to move, Enter to run the highlighted command (commands that need an argument, like `/workflow`, are filled in for you to finish), Tab to fill it in without running, and Esc to close. The menu also works while the agent is running, and commands run at once: `/tools`, `/auto` and `/bypass` apply to the agent's next action; `/model`, `/effort`, `/skills` and `/plan` apply from the next request. Only commands that would disrupt the running turn (`/clear`, `/resume`, `/sessions`, `/login`, `/logout`, `/update`, and running a `/workflow`) are marked "runs when this turn ends" and wait for it to end.

| Command | What it does |
|---|---|
| `/login` | Paste your API key (input is masked). The key is checked against the API before it's saved. |
| `/logout` | Remove the saved API key. |
| `/model` | Pick a model from the live list. The current model is marked. Your chat history is kept when you switch, and your choice is remembered. |
| `/model <id>` | Switch straight to a model by its id. |
| `/effort` | Set reasoning effort: `auto` (default; the model decides, except that short, simple messages are sent at `low`), `low`, `medium` or `high`. `/effort high` sets it directly. Remembered between runs. |
| `/skills` | Switch skills on or off for this chat (Space or Tab toggles; Enter or Esc closes). `/skills <name>` toggles one; `/skills new <name>` creates one in `~/.unjailed/skills`, and `/skills new <name> --project` creates it in `./.unjailed/skills`. |
| `/tools [read\|cmds\|yolo\|off]` | With no argument, choose permissions from a menu: read-only, file changes/commands with confirmations, automatic tools, or off. `/tools read`, `/tools cmds`, `/tools yolo` and `/tools off` set a mode directly (see [Agent tools](#agent-tools)). Picking a mode also resets `/auto`: only `yolo` runs without confirmations. |
| `/api` | Show the base URL, masked key and current model, and run a live connection check. |
| `/remember [text\|clear]` | Pin an important instruction for this session (up to 20 notes / 8,000 characters). No argument shows your notes; `clear` removes them. Saved notes return with `/resume`. |
| `/context` | Show token usage for this chat: current context size, the last turn's prompt/completion tokens, message count and model. Numbers come from the API (or a `~` estimate if the server sends none). The context size also shows live in the status line as `12.4k ctx`. |
| `/fun` | Toggle the fun effects — the startup wink, side snow and finish sparkle. `/fun off` turns them off; the choice is saved. Effects are off automatically when output is piped, `NO_COLOR` is set, or the terminal is small. |
| `/update` | Update the CLI to the latest version from npm. |
| `/auto` (`/bypass`) | Auto-approve enabled tools. In read/off mode it opens the permission picker; access changes only after your selection. `/auto off` restores confirmations, including when automatic tools were selected. Plan approvals still apply when plan mode is on. |
| `/plan` | Plan mode: with `/tools cmds` or `yolo`, before acting on each message you send, the agent shows a numbered plan of up to 8 steps. `y` approves and `n`/Esc rejects; the arrow keys or Tab switch between "Yes, start it" and "No, tell me what to change", and Enter confirms the selected one. `/plan off` disables. |
| `/goal <condition>` | Keep working until the condition holds, e.g. `/goal npm test passes with no failures`. After every turn an independent evaluator checks the evidence; if the goal isn't met, the agent continues with the evaluator's feedback. Up to 20 turns (`--max N`, at most 100); the condition can be up to 4,000 characters. `/goal` shows progress, `/goal clear` stops, `/goal resume` continues a paused goal. |
| `/loop [interval] <prompt>` | Repeat a prompt or `/command`: `/loop 5m check the deploy`, `/loop run the tests every 2h`. A fixed interval must be between 10 seconds and 7 days. Without an interval the agent paces itself, choosing each delay (1 minute – 1 hour) or ending the loop when its job is done. Starting a new loop replaces the current one. `/loop` shows status, `/loop resume` continues a paused loop, and `/loop stop` ends it. |
| `/workflow <name> [args]` | Run a saved multi-agent workflow (see [Subagents and workflows](#subagents-and-workflows)). Tools must be on. Args are parsed as JSON when they are valid JSON, otherwise passed as text. `/workflow new <name>` creates one from a template in this project; add `--user` to create it in your user folder. `/workflow` with no name lists them. |
| `/workflows` | List saved workflows. |
| `/verbose [on\|off]` | Show what the model is thinking: its reasoning streams into the transcript as dimmed `∴` blocks, each subagent's tool calls are listed, and tool results show up to 40 lines. Ctrl+O toggles. Remembered between runs. |
| `/stats` | Requests (and retries), time to first token, speed, context size, input/output/reasoning tokens, tools by kind, agents and recoveries for the last turn, plus session totals. |
| `/agents` | Show every agent of the last turn (main agent, subagents, workflow agents): status, time, tool uses, and input/output/reasoning tokens. |
| `/resume` | Pick up a previous chat from the current folder (or from every folder if this one has none). In the picker, Enter resumes, `a` shows every folder, and `d` then `y` deletes. `/resume 2` or `/resume <id>` jumps straight to one. |
| `/sessions` | Browse saved chats from every folder: Enter resumes one, `d` then `y` deletes it. `/sessions <n\|id>` jumps straight to one. |
| `/clear` | Start a new chat and clear the screen. The previous chat stays saved. |
| `/help` | List commands and keyboard shortcuts. |
| `/exit` | Quit. Ctrl+C twice or Ctrl+D also works. |

### Updating

`/update` pulls the newest version from npm. If your `/update` seems stuck on an old version, you're on a build from before this was fixed — update once by hand and it'll work normally after that:

```sh
npm install -g unjailed@latest
```

## What you see while the agent works

Every turn shows a live status line until it ends:

```
✻ Running… (1m 12s · ↓ 3.4k tokens · Bash(npm test) · esc esc to stop · ctrl+t agents)
  ⎿  ◐ Find auth call sites  Search("login")  14s · ↑8.2k ↓1.1k
     ✓ Review tests  done                       31s · ↑5k ↓900
```

It says what is happening (waiting for the model, thinking, writing, running a
tool, waiting for your approval, coordinating subagents, checking a goal,
reconnecting), how long the turn has run, how many tokens it has produced, and
what each subagent is doing. Tool calls print as compact blocks: `Read(file)`,
`Update(file)` with a colored diff, `Bash(command)` with its output, and
`Agent(task)` with `Done (4 tool uses · 2.1k tokens · 18s)`. While reconnecting, a row such as
`⚠ The connection dropped — retrying in 8s (attempt 3)` counts down to the next attempt.

**Agents view.** Press **Ctrl+T** while a turn runs to expand the panel into a
live table of every agent, the main agent included:

```
╭ Agents  Workflow review · Verify · 2/3 done ─────────────────────────────────╮
│   Agent              Status              Time  Tools   ↑ In  ↓ Out  ∴ Think │
│ ◐ main agent         coordinating      1m 12s      3  12.4k   3.1k      820 │
│ ◐ Review api         Read(src/api.ts)     32s      6   8.2k   1.2k      400 │
│ ✓ Review tests       done                 18s      4   5.1k    900        – │
│   Total              3 agents                     13  25.7k   5.2k    1.2k  │
╰─────────────────────────────────────────────────────────────────────────────╯
```

↑ is input (prompt) tokens, ↓ output tokens, and ∴ reasoning tokens (as
reported by the server, or estimated from streamed thinking). States are
color-coded: thinking, writing, running a tool, waiting for approval,
reconnecting, done, failed. Columns drop out on narrow terminals. `/agents`
prints the same table for the last turn after it ends.

**Live stats (verbose).** While `/verbose` is on, a stats panel under the
status line updates in real time: requests and retries, time to first token,
output speed, context size, input/output/reasoning tokens, tool calls by kind,
agents running and done, automatic recoveries, and the session totals. The
footer keeps the session totals when idle. `/stats` prints the same numbers at
any time.

**Verbose.** By default, thinking is summarised as `✻ Thought for 12s` and
tool output as a short preview. `/verbose` (or Ctrl+O, even mid-turn) shows the
reasoning itself as it streams, every tool call a subagent makes
(`↳ Review api: Read(src/api.ts)`), what each thinking subagent is weighing in
the agents panel, and up to 40 lines of each tool result.

Every turn ends with a line saying what happened: `✻ Worked for 1m 12s · 9 tool
calls · ↓ 3.4k tokens`, or why it stopped. A turn never ends silently.

**Messages while the agent works.** Type and press Enter at any time. With
tools on, your message reaches the agent as soon as the tool that is running
finishes, so you can steer it mid-task. If the agent had planned more tool
calls in the same batch, those are skipped and reported to it, and it
re-plans with your message. With tools off, messages queue and run when the turn ends. Slash commands run at once, even mid-turn: `/tools` and `/auto` apply to the agent's next action, and `/model` and `/effort` apply from the next turn. Only `/clear`, `/resume`, `/sessions`, `/login`, `/logout`, `/update` and running a saved `/workflow` wait for the turn to end.

**Permission prompts** show the exact command, file content or diff, and which
subagent asked when it isn't the main agent. Parallel subagents' requests appear
one at a time. Press `y` (or `1`) to allow it once, `a` (or `2`) to allow that
tool for the rest of the session, or `n`/`3`/Esc to decline. Ctrl+C declines and
stops the turn. Typing anything else starts a message to the agent instead (it is
never taken as an answer), and Enter sends it.

## Reliability

- **Outages are waited out, not fatal.** Network errors, timeouts, stalled
  streams, `5xx`, `429`, overload responses, and errors the server reports
  inside a stream (such as "The model stream was interrupted. Retry to
  continue.") are retried automatically with exponential backoff (1s, 2s, 4s …
  up to 60s, honoring `Retry-After` up to 5 minutes) until the service answers.
  A server that keeps closing the stream without replying is given up on after
  12 tries in a row, and empty or malformed responses after 3, with a message
  saying to send "continue". This applies
  everywhere: the main agent, subagents, workflow agents, goal checks and plan
  drafts. The status line shows a countdown. Esc Esc stops waiting. Invalid
  keys, missing credit, over-long context and malformed requests stop at once
  with a clear message. A model that only deliberates past the reasoning
  deadline (180 s, `UNJAILED_REASONING_TIMEOUT`) is asked to act instead, up to
  twice per turn. A stream silent for `UNJAILED_TIMEOUT` seconds (default 120)
  counts as stalled.
- **Cut-off replies are resumed.** If a stream ends early or the connection
  drops mid-reply, the agent continues from where it stopped instead of
  starting over, and you see a note saying so. Repeated interruptions wait a
  little longer each time. After 12 in a row the turn ends and says so.
- **No silent stops.** When a reply hits the output limit, the agent continues
  it. When the agent announces a step ("Now I'll update the tests:") but
  doesn't take it, it's prompted to carry on. Tool calls whose arguments were
  cut off are never executed. Instead, the agent is told to retry with smaller
  pieces. These recoveries are bounded: up to 3 output-limit continuations and
  2 nudges per turn. A turn also stops after 100 tool rounds (60 for a
  subagent) and says so. Send "continue" to keep going.
- **Clean output.** Colors, cursor movement, carriage-return progress bars,
  tabs, and emoji whose width terminals disagree on (`⚠️`, joined sequences
  like `👨‍👩‍👧`) are normalized before display, so long sessions don't drift
  out of alignment. Layout adapts to the terminal
  width and is reprinted on resize.

## Subagents and workflows

With tools on, the agent can start **subagents** (the `agent` tool): fresh
agents with their own empty context that take on one focused task, such as
searching a codebase or reviewing a module, and report back. Several subagents
started together run in parallel, and each appears live in the status panel.
Subagents use the same permissions as the main agent and can't start more
subagents.

With tools on, you can run saved **workflows** with `/workflow <name>`; with
`/tools cmds` or `yolo`, the agent can also write and run them itself: short
JavaScript scripts that orchestrate many subagents deterministically.

```js
export const meta = { name: "review", description: "Review each area, then verify" };

const areas = Array.isArray(args) ? args : ["error handling", "tests"];
phase("Review");
const reports = await parallel(areas.map((area) => () =>
  agent(`Review ${area}. Report findings with file:line.`, { label: area })));
phase("Verify");
return await pipeline(reports.filter(Boolean), (report) =>
  agent(`Verify each finding below by reading the code:\n${report}`, {
    label: "verify",
    schema: { type: "object", properties: { confirmed: { type: "array" } } },
  }));
```

| Function | Purpose |
|---|---|
| `agent(prompt, { label, phase, schema })` | Run a subagent; returns its report, or parsed JSON when `schema` is given (`{ error, raw }` if the reply isn't valid JSON) |
| `parallel([() => …, …])` | Run thunks concurrently; a failed item becomes `null` |
| `pipeline(items, stage1, stage2, …)` | Each item flows through the stages independently: `(previous, item, index)`; a stage returning `null` ends that item |
| `phase(title)`, `log(message)`, `args` | Progress labels, log lines, and the arguments passed in |

A workflow can start at most 16 agents, 4 at a time. When the agent starts a
workflow in `cmds` mode you approve it first (typing `/workflow <name>` is itself
the approval), and its subagents still ask before each change. Create one
with `/workflow new <name>` (add `--user` for every folder), which saves
`.unjailed/workflows/<name>.js` (this project) or
`~/.unjailed/workflows/<name>.js` (everywhere). `.mjs` also works, and a project
workflow wins on a name clash. `/workflows` lists them. Run one with
`/workflow <name> [json args]`, or ask the agent to. Scripts run in a separate JavaScript context, which is not
a security sandbox: run only workflows you trust, like any script.

## Sessions

Every chat is saved automatically and tagged with the folder you started
`unjailed` in, so each project keeps its own history: `/resume` lists that
folder's chats, and ↑ recalls the prompts you typed there in earlier sessions.

Saving never waits for a turn to finish. Your message is saved when you send
it, each tool result as it completes, and everything else (including the
reply while it streams) by an autosave every 10 seconds
(`UNJAILED_AUTOSAVE_SECONDS`). If you close the terminal, press Ctrl+C or the
CLI is killed mid-run, `/resume` (or `unjailed -c`) brings the chat back
entirely: messages, tool results in their places, the partial reply of the
interrupted turn, pinned notes, skills, model, ↑ history, session stats, and
any `/goal` or `/loop` (restored paused, so nothing runs on its own; `/goal resume`
or `/loop resume` restarts it). The
input box is pre-filled with "Continue where you left off." so Enter picks the
work back up.

Long chats automatically shorten older **request context** to keep the terminal
and requests responsive. Requests target about 96,000 characters and 160 recent
messages; the initial task, system instructions, recent turns and complete live
tool-call/result groups are retained. These are targets: a large active tool
group or protected recent turn can exceed them. The CLI tells you when older
request text was shortened or omitted. Your full chat text stays in the current
session and in saved chats. In agent mode, the read-only `search_history` tool
can search and recover exact previous messages and tool results, including
after `/resume`. `/remember <instruction>` keeps your most important constraints
in each request. `/clear` starts a fresh task and keeps the previous saved chat
available through `/resume`.

```sh
unjailed -c     # continue the most recent chat in this folder
unjailed -r     # choose a saved chat to resume
```

Inside the app, `/resume` lists this folder's chats (or every folder's, when this one has none), `/resume <n|id>` opens one directly, and `/sessions` lists all of them. Sessions use a small JSON manifest and an append-only JSONL history in `~/.unjailed/sessions/` (permissions `600`); the newest 200 are kept. To turn saving off, set `UNJAILED_NO_HISTORY=1` or put `"saveSessions": false` in `config.json`.

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

In every tools mode the agent can also start [subagents](#subagents-and-workflows) with the same permissions; the agent's `workflow` tool needs `cmds` or `yolo` (`/workflow <name>` works in `read`, `cmds` or `yolo`, but not with tools off).

The toolkit:

| Tool | What it does |
|---|---|
| `read_file` | Read a file (whole files up to 200 KB; larger ones up to 5 MB in sections with `start_line`/`max_lines`) |
| `list_dir` | List a directory (up to 500 entries) |
| `glob` | Find files by name pattern (`**/*.ts`), up to 200 results |
| `grep` | Search file contents, regex, file:line results (up to 100) |
| `open_url` | Open an http/https URL in your default browser (cmds/yolo) |
| `clipboard` | Read clipboard; writes require cmds/yolo |
| `launch_app` | Open an app or file with the OS (cmds/yolo) |
| `move_file` | Move/rename without overwriting an existing destination (cmds/yolo) |
| `delete_file` | Move to Trash; permanent deletion must be explicit (cmds/yolo) |
| `web_fetch` | Fetch a page/API and read it as text (200 KB, 15 s timeout) |
| `write_file` | Create or overwrite a file, up to 200 KB (cmds/yolo) |
| `edit_file` | Exact string replace in a file, optionally every occurrence with `replace_all` (cmds/yolo) |
| `run_command` | Shell with `cwd`, `timeout_ms` and `background` options (cmds/yolo) |
| `process_status` | Read a background job's status and recent output |
| `stop_process` | Stop a background job and its children (cmds/yolo) |
| `agent` | Start a subagent for a focused task; several run in parallel |
| `workflow` | Run a multi-agent workflow script (cmds/yolo) |
| `search_history` | Search and read back earlier messages and tool results of this chat, including after `/resume` (read-only) |
| `schedule_next` | Self-paced `/loop` only: choose when the next run happens, or end the loop |

Commands run through `cmd /d /s /c` on Windows and `/bin/sh -c` elsewhere.
`run_command` accepts `cwd` so the agent can build and run projects anywhere your
OS account can access, including folders with spaces. All filesystem tools and
command directories support `~/` and the `Desktop`, `Documents`, `Downloads`,
`Pictures`, `Videos` and `Music` shortcuts. This is ordinary local-user access; OS permissions still apply.

In `/tools cmds`, file writes/edits/moves/deletes, clipboard writes, app launches
and commands require your approval. `/tools read` enforces read-only tools even
if a model requests an unlisted tool. `/auto` in read/off mode asks you to choose
access; cancel keeps the current permissions. `/tools cmds` always enables
confirmations, even if auto approval was previously active. `/tools yolo` or
`/auto` with enabled command tools skips per-action prompts by your choice;
`/auto off` restores them.
Plan mode requires an approved plan before tasks in cmds/yolo mode; if planning
fails, execution stops.

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
| Enter | Send. While the agent works (tools on), your message is delivered to it at its next step. Most `/commands` run at once even mid-turn; plain-chat messages (tools off) and the commands that would disrupt the turn are **queued** and run when it finishes (the footer shows how many are waiting). |
| Shift+Enter, or `\` then Enter | New line. Alt+Enter and Ctrl+J also work, for terminals that don't report Shift+Enter. |
| ↑ / ↓ | Step through your previous inputs (on the first/last line); inside a multi-line draft they move the cursor between lines |
| ← / →, Home / End | Move the cursor; Home/End jump to the start/end of the line |
| Ctrl+A / Ctrl+E | Jump to the start / end of the line |
| Ctrl+U / Ctrl+K | Delete to the start / end of the line |
| Ctrl+W | Delete the previous word |
| Space | Toggle a skill in `/skills` |
| Paste | Multi-line pastes stay in the input box; they're never sent until you press Enter |
| Esc | Close menus. While a turn is running, press Esc **twice** to stop it (the first press arms it, so a stray Esc won't kill a long run). This also stops subagents, workflows and retry waits. |
| y / a / n (or 1 / 2 / 3) | Answer a permission prompt: allow once, allow that tool for the session, decline. Esc also declines; Ctrl+C declines and stops the turn. Typing anything else starts a message instead; Enter sends it to the agent while the prompt stays open. |
| Ctrl+T | Expand or collapse the live agents view |
| Ctrl+O | Toggle verbose: thinking, subagent steps and full tool output |
| Ctrl+C | Stops the response while one is streaming. Otherwise closes an open picker, then clears the input; press it twice to exit. |
| Ctrl+D | Exit (when the input is empty and no turn is running) |

## Environment variables

| Variable | Purpose |
|---|---|
| `UNJAILED_API_KEY` | API key. Takes priority over the saved key. |
| `UNJAILED_BASE_URL` | API base URL (default `https://unjailedai.com/v1`) |
| `UNJAILED_MODEL` | Model to start with (default: the one last picked with `/model`, else `glm-5.3`) |
| `UNJAILED_HOME` | Config directory (default `~/.unjailed`) |
| `UNJAILED_TIMEOUT` | Request/stream timeout in seconds (default 120 — reasoning models can think for a while before the first token) |
| `UNJAILED_REASONING_TIMEOUT` | Seconds a stream may produce only reasoning, with no answer or tool call, before it stops (default 180) |
| `UNJAILED_AUTOSAVE_SECONDS` | How often the open chat is autosaved, idle or mid-run, in seconds (default 10, minimum 1) |
| `UNJAILED_NO_HISTORY` | Set to `1` (any value except `0`/`false`) to stop saving chats (disables `/resume`); `"saveSessions": false` in config.json does the same |
| `UNJAILED_NO_FX` | Set to `1` or `true` to turn off the fun effects (wink, snow, sparkle) |
| `NO_COLOR` | Turn off colors (also turns off the fun effects) |
| `FORCE_COLOR` | Force a color level (`1`, `2` = 256 colors, `3` = truecolor), or `0` to turn colors off (that also turns off the fun effects) |

## Config location

| OS | Path |
|---|---|
| macOS / Linux | `~/.unjailed/config.json` (permissions `600`) |
| Windows | `%USERPROFILE%\.unjailed\config.json` |

The file holds `apiKey`, `model`, an optional `baseUrl`, `saveSessions`, `fx` (set `"fx": false` to disable the fun effects), and the settings the CLI remembers between runs: `effort` (`auto`/`low`/`medium`/`high`, set by `/effort`), `tools` (`off`/`read`/`cmds`/`yolo`) and `autoMode` (`ask`/`auto`), set by `/tools` and `/auto`, `plan` (`/plan`), `verbose` (`/verbose`), and `ignoreEnvKey` (set to `true` when a broken `UNJAILED_API_KEY` was bypassed so the saved key wins). An older `auth.json` key from the earlier `uj` CLI is still read if `apiKey` is missing. Saved chats live next to it in `sessions/`. Delete the whole `~/.unjailed` folder to reset everything. The CLI never prints your full key; it shows the key masked, for example `sk-…a1b2`.

## Privacy

The CLI sends no telemetry and no analytics. Its only network traffic is the API calls you trigger, the npm registry when you run `/update`, and, with agent tools on, any URLs the agent fetches with `web_fetch` (a read-only tool that runs without an approval prompt). Saved chat files stay on your machine in `~/.unjailed/sessions/`; request context and any history retrieved by the agent are sent to your configured API to answer your requests. Delete local histories with `/sessions` → `d`, delete the folder, or turn saving off with `UNJAILED_NO_HISTORY=1`.

## Development

```sh
npm install
npm run build     # compile TypeScript to dist/
npm run mock      # local mock API on http://localhost:8787/v1 (key: sk-mock-test-a1b2)
UNJAILED_BASE_URL=http://localhost:8787/v1 UNJAILED_HOME=./.dev node dist/index.js
npm test          # unit + integration tests against the mock
```

Put `ratelimit`, `servererror`, `credit`, `slow`, `hang`, `reason`, `markdown`, `longcode`, `usage`, `debug` (echoes the `reasoning_effort` and active skills it received) or `history` (reports the message count and the first message) in a chat message to make the mock server return that behavior. With tools on, the scripted agent scenarios `mock:edit`, `mock:agents`, `mock:workflow`, `mock:stall`, `mock:ansi`, `mock:emoji`, `mock:flaky`, `mock:batch`, `mock:think` and `mock:pace` exercise tool rounds, subagents, workflows, recovery paths and loops (`mock:workflow` needs `/tools cmds` or `yolo`); `mock:goal`, `mock:drop`, `mock:outage` and `mock:tick` work with tools off too, as does `mock:pace` inside a self-paced `/loop` (see the top of `mock/server.mjs`). Set `PORT` or `MOCK_KEY` to change the mock's port (default 8787) or accepted key (default `sk-mock-test-a1b2`).

The CLI continues when a model announces work without a tool call, with at most two recovery attempts and a clear failure message. It rejects incomplete tool arguments, preserves final streamed tool calls, supports line ranges in `read_file`, and preserves Windows CRLF and literal dollar characters in edits. Targeted edits and ranged reads support files up to 5 MB; individual full writes and replacements retain a 200 KB limit.

GLM 5.3 CLI requests default to low reasoning on the hosted API. `/effort high` remains available; the CLI's medium level maps to GLM's high level. Streams producing no answer or tool call stop after 180 seconds by default. Set `UNJAILED_REASONING_TIMEOUT` in seconds to override that deadline; `UNJAILED_TIMEOUT` controls header and idle timeouts (default 120 seconds). These controls improve response handling but cannot guarantee a model completes every task.

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

### Unreleased

`/goal` and `/loop` keep the agent working toward a condition or on an interval; the agent can run subagents and saved multi-agent workflows (`/workflow`, `/workflows`). `/verbose` (Ctrl+O) shows thinking, subagent steps and full tool output. `/stats` and `/agents` report per-turn and per-session numbers. Chats are saved continuously (every `UNJAILED_AUTOSAVE_SECONDS`, default 10), so `/resume` or `unjailed -c` restores an interrupted run in full. Slash commands run immediately while the agent works, except `/clear`, `/resume`, `/sessions`, `/login`, `/logout`, `/update` and running a workflow, which wait for the turn to finish.

### Coding reliability (0.12.4)

Update with `/update` or `npm install -g unjailed@latest`. Enable file and command access with `/tools cmds`; every change and command still asks for approval unless you explicitly enable automatic approval.
