/** Display-only decoding of incomplete JSON strings. Never repair arguments or
 * feed a draft into the executor. Work and memory stay bounded per fragment. */
export interface ToolDraft {
  index: number;
  name: string;
  label: string;
  target: string;
  preview: string;
  characters: number;
}

export const safeDraftText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export function toolActivity(name: string): string {
  return ({ write_file: "Writing file", edit_file: "Editing file", read_file: "Reading file", run_command: "Running command", list_dir: "Listing folder", glob: "Finding files", grep: "Searching code", web_fetch: "Fetching page", open_url: "Opening page", search_history: "Searching history", move_file: "Moving file", delete_file: "Deleting file" } as Record<string, string>)[name] ?? "Using tool";
}

export class ToolDraftBuffer {
  private name = "";
  private depth = 0;
  private inString = false;
  private escape = false;
  private unicode: string | null = null;
  private expectingKey = false;
  private expectingValue = false;
  private kind: "key" | "value" | "ignore" = "ignore";
  private key = "";
  private field = "";
  private target = "";
  private preview = "";
  private pendingPreview = "";
  private characters = 0;
  scannedCharacters = 0;
  constructor(private index: number) {}

  append(name: string, delta: string): void {
    this.name = name;
    // These are raw JSON characters, not a growing full-argument snapshot.
    for (const ch of delta) {
      this.scannedCharacters++;
      if (this.inString) {
        if (this.unicode !== null) {
          this.unicode += ch;
          if (this.unicode.length === 4) {
            if (/^[\da-f]{4}$/i.test(this.unicode)) this.capture(String.fromCharCode(parseInt(this.unicode, 16)));
            this.unicode = null;
          }
        } else if (this.escape) {
          this.escape = false;
          if (ch === "u") this.unicode = "";
          else this.capture(({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" } as Record<string, string>)[ch] ?? ch);
        } else if (ch === "\\") this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          if (this.kind === "key") { this.field = this.key; this.expectingKey = false; }
        } else this.capture(ch);
        continue;
      }
      if (ch === "{" || ch === "[") { this.depth++; if (this.depth === 1) this.expectingKey = true; }
      else if (ch === "}" || ch === "]") this.depth--;
      else if (this.depth === 1 && ch === ":") this.expectingValue = true;
      else if (this.depth === 1 && ch === ",") { this.expectingKey = true; this.expectingValue = false; }
      else if (ch === '"') {
        this.inString = true;
        this.kind = this.depth === 1 ? this.expectingKey ? "key" : this.expectingValue ? "value" : "ignore" : "ignore";
        if (this.kind === "key") this.key = "";
        if (this.kind === "value") {
          this.expectingValue = false;
          if (["content", "new_text", "command"].includes(this.field)) { this.preview = this.pendingPreview = ""; this.characters = 0; }
          if (["path", "url", "pattern", "query"].includes(this.field)) this.target = "";
        }
      }
    }
    this.flushPreview();
  }

  private flushPreview(): void {
    if (this.pendingPreview) { this.preview = (this.preview + this.pendingPreview).slice(-2400); this.pendingPreview = ""; }
  }

  private capture(ch: string): void {
    if (this.kind === "key") { if (this.key.length < 80) this.key += ch; }
    else if (this.kind === "value") {
      if (["content", "new_text", "command"].includes(this.field)) {
        this.characters += ch.length;
        this.pendingPreview += ch;
        if (this.pendingPreview.length >= 256) this.flushPreview();
      }
      if (["path", "url", "pattern", "query"].includes(this.field) && this.target.length < 512) this.target += ch;
    }
  }

  snapshot(): ToolDraft {
    let preview = safeDraftText(this.preview).split("\n").slice(-6).join("\n");
    if (/^[\uDC00-\uDFFF]/.test(preview)) preview = preview.slice(1);
    return { index: this.index, name: safeDraftText(this.name), label: toolActivity(this.name), target: safeDraftText(this.target), preview, characters: this.characters };
  }
}
