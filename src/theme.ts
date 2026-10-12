import { Chalk, type ChalkInstance } from "chalk";
import { BRAND_BLUE, BRAND_DARK } from "./constants.js";

/** 0 = no color, 2 = 256 colors, 3 = truecolor. Honors NO_COLOR and FORCE_COLOR. */
export function detectColorLevel(env = process.env, isTTY = !!process.stdout.isTTY): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (env.FORCE_COLOR !== undefined) {
    const f = env.FORCE_COLOR;
    if (f === "0" || f === "false") return 0;
    if (f === "3") return 3;
    if (f === "2") return 2;
    if (f === "1" || f === "" || f === "true") return 1;
  }
  if (!isTTY || env.TERM === "dumb") return 0;
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  // Windows Terminal, VS Code, and modern macOS/Linux terminals all do truecolor.
  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return 3;
  if (process.platform === "win32") return 3;
  if (/kitty|alacritty|ghostty|foot|wezterm/.test(env.TERM ?? "")) return 3;
  if (/256/.test(env.TERM ?? "")) return 2;
  return 2;
}

export const colorLevel = detectColorLevel();
export const c: ChalkInstance = new Chalk({ level: colorLevel });

export const theme = {
  brand: (s: string) => c.hex(BRAND_BLUE)(s),
  brandBold: (s: string) => c.hex(BRAND_BLUE).bold(s),
  dim: (s: string) => c.gray(s),
  ok: (s: string) => c.green(s),
  err: (s: string) => c.red(s),
  warn: (s: string) => c.yellow(s),
  bold: (s: string) => c.bold(s),
  code: (s: string) => c.hex(BRAND_BLUE)(s),
  dark: BRAND_DARK,
};

/** One color per kind of activity, used by the status line, the agents view
 *  and tool blocks. Muted enough for long sessions, distinct at a glance. */
export const tone = {
  thinking: (s: string) => c.hex("#C4B5FD")(s), // violet
  writing: (s: string) => c.hex(BRAND_BLUE)(s), // brand sky
  tool: (s: string) => c.hex("#FCD34D")(s), // amber
  read: (s: string) => c.hex("#93C5FD")(s), // light blue
  edit: (s: string) => c.hex("#FDBA74")(s), // orange
  shell: (s: string) => c.hex("#86EFAC")(s), // green
  web: (s: string) => c.hex("#67E8F9")(s), // cyan
  agent: (s: string) => c.hex("#F0ABFC")(s), // fuchsia
  waiting: (s: string) => c.gray(s),
  approval: (s: string) => c.yellow(s),
  retrying: (s: string) => c.hex("#FB923C")(s), // deep orange
  goal: (s: string) => c.hex("#F9A8D4")(s), // pink
  done: (s: string) => c.green(s),
  failed: (s: string) => c.red(s),
};

/** Color names for Ink <Text color>; undefined when color is off. */
export const inkColor = (hex: string) => (colorLevel === 0 ? undefined : hex);

/* ─── fun effects (snow, sparkles, intro) — on-brand sky-blue + pale white ─── */
export const FX_SNOW = ["❄", "❅", "❆", "•", "·", "*"];
export const FX_SPARKLE = ["✦", "✧", "⋆", "✴", "✺"];
/** Pale sky-blue flakes; falls back to plain text when color is off. */
export const fxSnow = (s: string) => (colorLevel === 0 ? s : c.hex("#dbeafe")(s));
/** Brand-blue sparkle accent. */
export const fxSparkle = (s: string) => (colorLevel === 0 ? s : c.hex(BRAND_BLUE).bold(s));
/** Soft slate for secondary intro text. */
export const fxSlate = (s: string) => (colorLevel === 0 ? s : c.hex("#9fb3c8")(s));
