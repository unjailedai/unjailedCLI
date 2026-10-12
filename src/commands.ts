export interface CommandSpec {
  name: string;
  description: string;
  args?: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "login", description: "Log in with your API key" },
  { name: "logout", description: "Remove the saved API key" },
  { name: "model", description: "Choose a model", args: "[id]" },
  { name: "effort", description: "Set how hard the model thinks (auto, low, medium, high)", args: "[level]" },
  { name: "skills", description: "Switch skills on or off, or create one", args: "[name|new <name> [--project]]" },
  { name: "tools", description: "Choose read access, confirmed file changes/commands, or automatic tools", args: "[read|cmds|yolo|off]" },
  { name: "auto", description: "Auto-approve enabled tools; choose permissions first in read/off mode", args: "[off]" },
  { name: "bypass", description: "Alias of /auto — stop asking, just do" },
  { name: "plan", description: "Plan mode: with write/command tools on, the model drafts a numbered plan for you to approve first", args: "[off]" },
  { name: "goal", description: "Keep working until a condition is met (checked after every turn, up to 20 turns by default)", args: "[condition [--max N]|clear|resume]" },
  { name: "loop", description: "Repeat a prompt or /command on an interval, or self-paced", args: "[interval] <prompt>|stop|resume" },
  { name: "workflow", description: "Run a saved multi-agent workflow, or create one", args: "<name> [json args]|new <name> [--user]" },
  { name: "workflows", description: "List saved multi-agent workflows" },
  { name: "verbose", description: "Show the model's thinking, subagent steps and full tool output (Ctrl+O)", args: "[on|off]" },
  { name: "stats", description: "Requests, latency, speed, tokens, tools and agents for the last turn and this session" },
  { name: "agents", description: "Agents of the last turn: status, time, tools, input/output/reasoning tokens" },
  { name: "fun", description: "Toggle the fun effects (startup wink, side snow, sparkles)", args: "[on|off]" },
  { name: "api", description: "Show API endpoint, key and connection status" },
  { name: "remember", description: "Pin an instruction in this session, or view/clear notes", args: "[text|clear]" },
  { name: "context", description: "Show token/context usage for this chat" },
  { name: "update", description: "Update the CLI to the latest npm version" },
  { name: "resume", description: "Continue a previous chat from this folder", args: "[n|id]" },
  { name: "sessions", description: "Browse, resume or delete saved chats from every folder", args: "[n|id]" },
  { name: "clear", description: "Start a new chat and clear the screen (also clears pinned notes and session approvals)" },
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "exit", description: "Quit Unjailed" },
];

/** Commands that would disrupt a running turn (they replace the chat, the
 *  login, or the process, or start a turn of their own) wait for it to end.
 *  Everything else works at once, even while the agent is running. */
const WAITS_FOR_TURN = new Set(["clear", "resume", "sessions", "login", "logout", "update"]);

export function waitsForTurn(name: string, arg = ""): boolean {
  if (WAITS_FOR_TURN.has(name)) return true;
  // Running a saved workflow is a turn of its own; creating or listing one is not.
  if (name === "workflow") return !!arg.trim() && !/^new\s/i.test(arg.trim());
  return false;
}

/** @deprecated use waitsForTurn */
export const runsMidTurn = (name: string, arg = "") => !waitsForTurn(name, arg);

/** Commands matching what's typed after "/", prefix matches first. */
export function filterCommands(query: string): CommandSpec[] {
  const q = query.toLowerCase();
  if (!q) return COMMANDS;
  const prefix = COMMANDS.filter((c) => c.name.startsWith(q));
  const rest = COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...rest];
}

/** "/model glm" → { name: "model", arg: "glm" }; null if not a slash command. */
export function parseCommand(input: string): { name: string; arg: string } | null {
  const m = input.trim().match(/^\/(\S*)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), arg: m[2]!.trim() };
}
