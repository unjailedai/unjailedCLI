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
  { name: "skills", description: "Switch skills on or off, or create one", args: "[name|new <name>]" },
  { name: "tools", description: "Agent tools · \"cmds\" (default) edits files + runs commands, you confirm · no arg = read-only · \"yolo\" skips confirm", args: "[off|cmds|yolo]" },
  { name: "auto", description: "Auto-approve tool calls (like yolo, without changing tool set)", args: "[off]" },
  { name: "bypass", description: "Alias of /auto — stop asking, just do" },
  { name: "plan", description: "Plan mode (off by default): model drafts a numbered plan before touching anything", args: "[off]" },
  { name: "fun", description: "Toggle the fun effects (startup wink, side snow, sparkles)", args: "[on|off]" },
  { name: "api", description: "Show API endpoint, key and connection status" },
  { name: "context", description: "Show token/context usage for this chat" },
  { name: "update", description: "Update the CLI to the latest npm version" },
  { name: "resume", description: "Continue a previous chat from this folder", args: "[n|id]" },
  { name: "sessions", description: "Browse, resume or delete saved chats" },
  { name: "clear", description: "Start a new chat and clear the screen" },
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "exit", description: "Quit Unjailed" },
];

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
