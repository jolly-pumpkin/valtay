import { resolve } from "path";
import { valtayHome } from "./config.ts";
import type { PhaseId } from "./run/store.ts";
import researchPrompt from "../assets/phases/research.md" with { type: "file" };
import reconcilePrompt from "../assets/phases/reconcile.md" with { type: "file" };
import shapePrompt from "../assets/phases/shape.md" with { type: "file" };
import planPrompt from "../assets/phases/plan.md" with { type: "file" };

/**
 * Phase prompts, shipped as assets.
 *
 * An explicit manifest rather than a directory scan, for the same reason
 * `src/skills.ts` uses one: the `type: "file"` imports resolve to real paths when
 * running from source and to embedded files under `bun build --compile`, and neither
 * is enumerable.
 *
 * A phase whose prompt is not yet written is absent here rather than stubbed, so
 * reaching it fails loudly instead of invoking a model with nothing to go on.
 */
const SHIPPED: Partial<Record<PhaseId, string>> = {
  research: researchPrompt,
  reconcile: reconcilePrompt,
  shape: shapePrompt,
  plan: planPrompt,
};

/** Where a project-local override of a phase prompt lives. */
export function promptOverridePath(id: PhaseId): string {
  return resolve(valtayHome(), "phases", `${id}.md`);
}

/**
 * The prompt for `id`, preferring `~/.valtay/phases/<id>.md` when present.
 *
 * The override is how a promoted ledger entry reaches a phase (design.md §16.2) —
 * and it is also why Valtay never writes there itself (invariant 8): a harness that
 * edits its own prompts based on its own performance has no fixed point.
 */
export async function loadPrompt(id: PhaseId): Promise<string> {
  const override = Bun.file(promptOverridePath(id));
  if (await override.exists()) return override.text();

  const shipped = SHIPPED[id];
  if (!shipped) throw new Error(`No phase prompt for "${id}" — write assets/phases/${id}.md`);

  return Bun.file(shipped).text();
}
