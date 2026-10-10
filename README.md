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
| `/tools` | Agent tools. `cmds` (the default) lets the model change files, launch apps and run commands, with approval for each action; no argument switches to read-only; `yolo` skips asking; `off` is plain chat. |
| `/api` | Show the base URL, masked key and current model, and run a live connection check. |
| `/context` | Show token usage for this chat: current context size, the last turn's prompt/completion tokens, message count and model. Numbers come from the API (or a `~` estimate if the server sends none). The context size also shows live in the status line as `ctx 12.4k`. |
| `/fun` | Toggle the fun effects — the startup wink, side snow and finish sparkle. `/fun off` turns them off; the choice is saved. Effects are off automatically when output is piped, `NO_COLOR` is set, or the terminal is small. |
| `/update` | Update the CLI to the latest version from npm. |
| `/auto` (`/bypass`) | Auto-approve tool calls — the agent stops asking and just works. `/auto off` restores confirmations in `cmds` mode. It does not expand `read`/`off` permissions; select `/tools cmds` to leave `yolo`. |
| `/plan` | Plan mode (off by default): before writing files or running commands, the agent shows a numbered plan — Enter approves, Esc rejects. `/plan off` disables. |
| `/resume` | Pick up a previous chat from the current folder. `/resume 2` or `/resume <id>` jumps straight to one. |
| `/sessions` | Browse saved chats from every folder: resume one, or press `d` to delete it. |
| `/clear` | Start a new chat and clear the screen. The previous chat stays saved. |
| `/help` | List commands and keyboard shortcuts. |
| `/exit` | Quit. Ctrl+C twice or Ctrl+D also works. |

### Updating

`/update` pulls the newest version from npm. If your `/update` seems stuck on an old version, you're on a build from before this was fixed — update once by hand and it'll work normally after that:

```sh
npm install -g unjailed@latest
```

## Sessions

Chats are saved automatically after each reply, tagged with the folder you started `unjailed` in, so each project keeps its own history.

```sh
unjailed -c     # continue the most recent chat in this folder
unjailed -r     # choose a saved chat to resume
```

Inside the app, `/resume` lists this folder's chats and `/sessions` lists all of them. Sessions are stored as JSON in `~/.unjailed/sessions/` (permissions `600`); the newest 200 are kept. To turn saving off, set `UNJAILED_NO_HISTORY=1` or put `"saveSessions": false` in `config.json`.

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

Agent tools give the model hands: it reads, writes and edits files and runs
commands on your machine to do coding tasks, rather than pasting code into the
chat. They are on by default in `cmds` mode, where you approve each change or
command with `y`. It works the same on Linux, macOS and Windows.

| Mode | What the model can do |
|---|---|
| `/tools` | **Read-only:** read files, list directories, glob-find files, grep contents, read clipboard, fetch web pages, inspect background jobs |
| `/tools cmds` | **Default. + write:** write/edit/move/delete files, launch apps, run commands — you confirm each action with `y` |
| `/tools yolo` | Same as `cmds`, changes and commands run without confirmation |
| `/tools off` | Plain chat, no tools |

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
if a model requests an unlisted tool. `/auto` and `/tools yolo` are explicit
choices to skip prompts; `/auto` cannot unlock capabilities in read/off mode.
Plan mode (opt-in with `/plan`) requires an approved plan before tasks in
cmds/yolo mode; if planning fails, execution stops.

`glob` and `grep` run in a background thread, so a huge folder or a slow regex never
freezes the terminal: they skip `node_modules`, dot-folders and Windows `AppData`/`Program Files`
trees (search one directly to include it), stop after 100,000 files or 20 seconds,
and return what they found so far. While the agent works, the status line always
shows what it is doing: thinking, writing a reply, preparing a file, running a
tool, waiting for your approval, or waiting on a server that has gone quiet.

Foreground commands default to a 10-minute timeout; `timeout_ms` can shorten it. A command returns when it exits, even if a program it started (`start ...`) is still running.
Cancellation and timeouts kill the command's process tree. Output retains a
bounded tail plus the exit status. For a development server, use
`background: true`; the returned `job_id` works with `process_status` and
`stop_process` during the current CLI session. Recent output is saved to
`.unjailed/bg-*.log` with a 100 KB disk cap. Job controls are not restored after
restarting the CLI. Use an OS service manager for persistent services.

Example: ask “Create a JavaScript app in my
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

The CLI sends no telemetry and no analytics, and makes no requests other than the API calls you trigger. Saved chats stay on your machine in `~/.unjailed/sessions/` and are never uploaded; delete them with `/sessions` → `d`, delete the folder, or turn saving off with `UNJAILED_NO_HISTORY=1`.

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

## License

MIT · [github.com/unjailedai/unjailedCLI](https://github.com/unjailedai/unjailedCLI)
