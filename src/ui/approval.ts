/** Enter echoes and unrelated terminal keys must never grant PC access. */
export function approvalAnswer(input: string, key: {
  ctrl?: boolean; meta?: boolean; escape?: boolean; return?: boolean;
}, armedForMs: number): boolean | "always" | undefined {
  if (key.ctrl && input.toLowerCase() === "c") return false;
  if (armedForMs < 150) return undefined;
  if (key.escape) return false;
  if (key.ctrl || key.meta || key.return) return undefined;
  const value = input.trim().toLowerCase();
  if (value === "y" || value === "yes" || value === "1") return true;
  if (value === "a" || value === "2") return "always";
  if (value === "3") return false;
  if (value === "n" || value === "no") return false;
  return undefined;
}
