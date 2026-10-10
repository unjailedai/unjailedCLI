/** Numbered steps from a drafted plan, renumbered "1. …". Tolerates the
 *  markdown models add ("**1.**", "Step 1:", "- 1)"). Returns [] when there is
 *  no step 1, so an unusable draft never counts as a plan. */
export function planSteps(plan: string, max = 8): string[] {
  const step = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:step\s+)?(\d+)\s*[.):](?:\*\*|__)?\s*(.*)$/i;
  const steps: string[] = [];
  for (const line of plan.split("\n")) {
    const m = step.exec(line);
    if (!m) continue;
    const text = m[2]!.replace(/^(?:\*\*|__)\s*/, "").trim();
    if (!text.replace(/[*_]/g, "")) continue;
    if (!steps.length && m[1] !== "1") continue;
    steps.push(`${steps.length + 1}. ${text}`);
    if (steps.length === max) break;
  }
  return steps;
}
