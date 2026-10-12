/** Make untrusted text (model replies, tool and command output) safe to print.
 *
 * Raw control sequences move the terminal cursor behind Ink's back: an ANSI
 * color from `npm test`, a `\r` progress bar or a tab all leave Ink's idea of
 * the column wrong, and later lines appear shifted to the right. Escapes are
 * removed, `\r` keeps what the terminal would finally show, tabs expand to
 * spaces, and emoji with disputed widths are normalized, so every printed
 * cell is one Ink has counted.
 */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

/** C0/C1 controls (bell, backspace, form feed …) and bidi overrides. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/**
 * Emoji whose width terminals disagree on. "⚠️" (with the U+FE0F
 * presentation selector) is measured as 2 columns but drawn as 1 by many
 * terminals, and joined sequences like 👨‍👩‍👧 are measured as 2 but drawn
 * as up to 6. Either way every later cell on the line lands where Ink didn't
 * plan, so borders and text drift right. Dropping the selectors and the
 * zero-width joiners leaves characters every terminal draws at one width.
 */
const DISPUTED_WIDTH = /[︎️‍]/g;

export function sanitizeForDisplay(text: string, tabSize = 4): string {
  if (!text) return text;
  let s = text.replace(ESCAPES, "").replace(/\r\n/g, "\n");
  if (s.includes("\r")) s = s.split("\n").map((line) => line.split("\r").filter(Boolean).pop() ?? "").join("\n");
  if (s.includes("\t")) {
    s = s.split("\n").map((line) => {
      let col = 0;
      let out = "";
      for (const ch of line) {
        if (ch === "\t") {
          const pad = tabSize - (col % tabSize);
          out += " ".repeat(pad);
          col += pad;
        } else {
          out += ch;
          col++;
        }
      }
      return out;
    }).join("\n");
  }
  return s.replace(CONTROLS, "").replace(DISPUTED_WIDTH, "");
}
