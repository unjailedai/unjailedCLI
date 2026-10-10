import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";

/**
 * The live status line while the model works. Instead of a single opaque
 * "Thinking…", it tells the user WHAT is happening right now — a coding pass,
 * a shell command, reading files — with elapsed time. States:
 *
 *   idle      → pulsing dots (waiting for first token)
 *   reasoning → "Reasoning" with a brain pulse
 *   coding    → writing/editing files (brackets animation)
 *   command   → shell command running (prompt animation)
 *   reading   → reading files / searching
 *   browsing  → fetching a URL
 *   streaming → tokens landing (bytes counter)
 *   approval  → paused until the user answers y/n
 *
 * quietSince: when the model has sent nothing for a while the line says so,
 * so a slow or stalled server never looks like a frozen terminal.
 */

export type WorkKind = "idle" | "reasoning" | "streaming" | "coding" | "command" | "reading" | "browsing" | "approval";

const SPIN_FRAMES   = ["|", "/", "-", "\\"]; // classic rotating spinner
const CODE_FRAMES   = ["[ ]", "{ }", "[_]", "{~}"];
const CMD_FRAMES    = [">", ">>", ">>>", ">>", ">"];
const READ_FRAMES   = ["◂", "◄", "◀", "◄"];
const WEB_FRAMES    = ["⇄", "↻", "⟳", "↻"];
const STREAM_FRAMES = ["▁", "▃", "▅", "▆", "▅", "▃"];
const ASK_FRAMES    = ["?", "?", "?", " "];
/** Seconds of silence from the model before the status line mentions it. */
export const QUIET_AFTER_S = 8;

const META: Record<WorkKind, { frames: string[]; verb: string }> = {
  idle:      { frames: SPIN_FRAMES,   verb: "Thinking" },
  reasoning: { frames: SPIN_FRAMES,   verb: "Reasoning" },
  streaming: { frames: STREAM_FRAMES, verb: "Writing" },
  coding:    { frames: CODE_FRAMES,   verb: "Writing code" },
  command:   { frames: CMD_FRAMES,    verb: "Running command" },
  reading:   { frames: READ_FRAMES,   verb: "Reading files" },
  browsing:  { frames: WEB_FRAMES,    verb: "Fetching page" },
  approval:  { frames: ASK_FRAMES,    verb: "Waiting for your approval" },
};

export function Spinner({ label, kind = "idle", detail, quietSince }: { label?: string; kind?: WorkKind; detail?: string; quietSince?: number }) {
  const [i, setI] = useState(0);
  const [start] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setI((n) => n + 1);
      setTick((n) => n + 1);
    }, 110);
    return () => clearInterval(t);
  }, []);
  const meta = META[kind];
  const secs = Math.floor((Date.now() - start) / 1000);
  const timeStr = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  // blink the elapsed counter every ~half second so the line feels alive even between frames
  const showTime = tick % 10 !== 9 || secs === 0;
  const frame = meta.frames[i % meta.frames.length]!;
  const frameStr = theme.brand(frame);
  const verb = label ?? meta.verb;
  const quiet = quietSince ? Math.floor((Date.now() - quietSince) / 1000) : 0;
  const stop = kind === "approval" ? "y = allow · n/Esc = skip" : "Ctrl+C to stop";
  const tail = showTime ? `${timeStr} · ${stop}` : `${timeStr}  · ${stop}`;
  return (
    <Text>
      {frameStr} {theme.bold(verb)}
      {detail ? theme.dim(` · ${detail.length > 48 ? detail.slice(0, 48) + "…" : detail}`) : ""}
      {theme.dim(` · ${tail}`)}
      {quiet >= QUIET_AFTER_S ? theme.warn(` · no data from the model for ${quiet}s`) : ""}
    </Text>
  );
}
