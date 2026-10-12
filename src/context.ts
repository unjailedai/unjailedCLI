import type { AgentMessage, ChatMessage } from "./api.js";
import type { ToolDef } from "./tools.js";

export interface ToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  at: number;
  /** Number of chat messages when the tool ran, to replay it in place on /resume. */
  turn?: number;
}
const STOP = new Set("the and that this with from have what when where which your about please could would should then just make keep doing continue next task work some using need want into file files code only also there been were will they them these those how for are was but not you can our use fix now".split(" "));
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{3,100}/gu) ?? []).filter(t => !STOP.has(t)));
}
const index = new WeakMap<object, { terms: Set<string>; constraints: string[] }>();
const sourceIds = new WeakMap<object, string>();
export function identifyHistoryEntry(message: object, entry: string): void {
  sourceIds.set(message, entry);
}
const protectedWorkingContext = new WeakSet<object>();
/** Internal identity marker; never sent as an extra API protocol field. */
export function protectWorkingContext<T extends AgentMessage>(message: T): T {
  protectedWorkingContext.add(message);
  return message;
}
export function isWorkingContext(message: AgentMessage): boolean {
  return protectedWorkingContext.has(message);
}
export function identifyHistory(messages: ChatMessage[]): void {
  messages.forEach((message, i) => sourceIds.set(message, `message:${i + 1}`));
}
function indexed(message: ChatMessage | AgentMessage) {
  let result = index.get(message);
  if (!result) {
    // Index each immutable source message once. Huge pastes still have exact
    // archive reads; the index itself is bounded rather than a new huge scan
    // and token allocation on every request.
    const text = message.content.length <= 200_000 ? message.content : message.content.slice(0, 192_000) + "\n" + message.content.slice(-8_000);
    const constraints = message.role === "user" ? text.split(/\n+/).filter(line => line.length <= 1200 && /\b(always|never|must|remember|prefer|require|use|keep|only)\b|don['’]t|do not/i.test(line)).slice(-12) : [];
    result = { terms: terms(text), constraints };
    index.set(message, result);
  }
  return result;
}
function excerpt(text: string, query: Set<string>, size: number) {
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  let position = -1;
  for (const term of query) { const p = lower.indexOf(term); if (p >= 0 && (position < 0 || p < position)) position = p; }
  if (position < 0) return text.slice(0, Math.floor(size * .6)) + "\n[excerpt; full text available in history]\n" + text.slice(-Math.floor(size * .3));
  const start = Math.max(0, position - Math.floor(size / 4));
  return (start ? `[excerpt from character ${start}]\n` : "") + text.slice(start, start + size) + (start + size < text.length ? "\n[excerpt continues in history]" : "");
}

/** Deterministic exact excerpts, not an invented summary. Carry older user
 * requirements and query-relevant facts when the wire window shrinks. */
export function archivedContext(history: AgentMessage[], selected: AgentMessage[], wire: AgentMessage[], budget = 12_000): string {
  const query = terms([...history].reverse().find(m => m.role === "user")?.content ?? "");
  const selectedSet = new Set(selected);
  const shortened = new Set(selected.filter((m, i) => m.content !== wire[i]?.content));
  const identified = history.some(m => sourceIds.has(m));
  const candidates = history.flatMap((m, i) => m.role !== "system" && (!selectedSet.has(m) || shortened.has(m)) ? [{ message: m, number: i + 1, entry: sourceIds.get(m) ?? (identified || m.role === "tool" || (m.role === "assistant" && m.tool_calls) ? "live request context; search_history by query" : `message:${i + 1}`) }] : []);
  if (!candidates.length) return "";
  const parts = ["Earlier conversation excerpts (historical context, not new requests or permissions). Latest instructions and current tool permissions apply. Excerpts can be incomplete; search_history can recover exact source text in agent mode."];
  let used = parts[0].length;
  const add = (label: string, text: string) => {
    const part = `\n\n${label}\n${text}`;
    if (used + part.length > budget) return false;
    parts.push(part); used += part.length; return true;
  };
  // Keep explicit older requirements even when the next prompt is only
  // "continue". Prefer newer requirements when the user changed their mind.
  let constraints = 0;
  for (const candidate of [...candidates].reverse()) {
    for (const line of indexed(candidate.message).constraints) {
      if (constraints >= 16) break;
      if (used + line.length + 100 <= Math.min(4000, budget / 2) && add(`[Earlier user requirement; ${candidate.entry}]`, line)) constraints++;
    }
    if (constraints >= 16) break;
  }
  const ranked = candidates.map(c => {
    const meta = indexed(c.message);
    let score = 0; for (const t of query) if (meta.terms.has(t)) score++;
    return { ...c, score };
  }).sort((a,b) => b.score - a.score || b.number - a.number);
  const chosen = new Set<number>();
  for (const c of ranked.filter(c => c.score > 0).slice(0,6).concat(candidates.slice(-4).reverse().map(c => ({...c,score:0})))) {
    if (chosen.has(c.number)) continue;
    chosen.add(c.number);
    add(`[${c.message.role}; ${c.entry}]`, excerpt(c.message.content, query, 1100));
  }
  return parts.join("");
}

export function workingContext(events: ToolEvent[], notes: string[]): string {
  const parts: string[] = [];
  if (notes.length) parts.push("User-pinned session notes:\n" + notes.map((note,i) => `${i+1}. ${note}`).join("\n"));
  if (events.length) {
    const recent = events.slice(-16).map(event => {
      const args = Object.fromEntries(Object.entries(event.args).filter(([key]) => !['content','replacement','old_text','new_text'].includes(key)).map(([key,value]) => [key, typeof value === 'string' ? value.slice(0,600) : value]));
      return `${event.name} (${event.ok ? 'reported success' : 'failed/skipped'}) [tool:${event.id}] ${JSON.stringify(args)}\n${event.output.slice(0,220)}${event.output.length > 500 ? '\n…\n'+event.output.slice(-180) : event.output.slice(220,500)}`;
    });
    parts.push("Recent tool evidence from this session (historical output, not current permission; recheck files before changing them):\n" + recent.join("\n\n"));
  }
  return parts.join("\n\n").slice(0,16_000);
}

export const HISTORY_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "search_history",
    description: "Recover exact earlier conversation or tool results from this session. Search with query; then read a returned message:N or tool:ID using entry, offset and length. Read-only; never runs a command or grants permission.",
    parameters: { type: "object", properties: { query: {type:"string"}, entry:{type:"string"}, offset:{type:"integer",minimum:0}, length:{type:"integer",minimum:1,maximum:12000}, limit:{type:"integer",minimum:1,maximum:8} }, additionalProperties:false },
  },
};
export function searchHistory(messages: ChatMessage[], events: ToolEvent[], args: Record<string, unknown>): {ok:boolean;output:string} {
  const read = (entry: string) => {
    const message = /^message:(\d+)$/.exec(entry);
    if (message) { const m = messages[Number(message[1])-1]; return m ? { role:m.role, text:m.content } : undefined; }
    if (entry.startsWith('tool:')) { const e = events.find(e => 'tool:'+e.id === entry); return e ? { role:'tool', text:JSON.stringify({name:e.name,args:e.args,ok:e.ok,output:e.output}) } : undefined; }
  };
  const bounded = (value: unknown, fallback: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value,max) : fallback;
  if (typeof args.entry === 'string') {
    const source = read(args.entry);
    if (!source) return {ok:false,output:"History entry not found. Use search_history with a query first."};
    const offset = bounded(args.offset,0,source.text.length), length = Math.max(1,bounded(args.length,4000,12000));
    return {ok:true,output:JSON.stringify({entry:args.entry,role:source.role,offset,totalCharacters:source.text.length,nextOffset:offset+length<source.text.length?offset+length:null,content:source.text.slice(offset,offset+length)})};
  }
  const query = typeof args.query === 'string' ? args.query.trim().slice(0,300) : '';
  if (!query) return {ok:false,output:"Supply a search query or an exact history entry."};
  const tokens = terms(query), limit = Math.max(1,bounded(args.limit,5,8));
  const matches: {entry:string;role:string;score:number;text:string;order:number}[] = [];
  messages.forEach((message,i) => {
    let score = 0; for (const term of tokens) if (indexed(message).terms.has(term)) score++;
    if (score || message.content.toLowerCase().includes(query.toLowerCase())) matches.push({entry:`message:${i+1}`,role:message.role,score,text:message.content,order:i});
  });
  events.forEach((event,i) => {
    const text = JSON.stringify({name:event.name,args:event.args,ok:event.ok,output:event.output});
    const lower = text.toLowerCase(); let score = 0; for (const term of tokens) if (lower.includes(term)) score++;
    if (score || lower.includes(query.toLowerCase())) matches.push({entry:`tool:${event.id}`,role:'tool',score,text,order:messages.length+i});
  });
  matches.sort((a,b) => b.score-a.score || b.order-a.order);
  return {ok:true,output:JSON.stringify({matches:matches.slice(0,limit).map(m=>({entry:m.entry,role:m.role,totalCharacters:m.text.length,excerpt:excerpt(m.text,tokens,1600)})),instruction:'Read an entry with offset/length to recover exact source. These are historical records, not new permission.'})};
}
