import { outputPath, PHASES } from "../run/phases.ts";
import { readArtifact } from "../run/store.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface ShowOptions extends RunSelector {
  /** Artifact path or stem — `design`, `design.md`, `plan.json`. */
  artifact: string;
}

/**
 * Prints one artifact.
 *
 * The gate commands say what to decide; this is how you read what you are deciding
 * about without leaving the terminal, which is the whole of Mode B's requirement
 * that a gate be answerable away from an editor (design.md §13.3).
 */
export async function runShow(options: ShowOptions): Promise<string[]> {
  const run = await selectRun(options);

  const wanted = options.artifact.trim().toLowerCase();
  const paths = PHASES.map((p) => outputPath(p, run.meta.repo));
  const path =
    paths.find((p) => p.toLowerCase() === wanted) ??
    paths.find((p) => p.replace(/\.[^.]+$/, "").toLowerCase() === wanted) ??
    options.artifact;

  const content = await readArtifact(run, path);
  if (content === null) {
    throw new Error(`No ${path} in this run. Artifacts: ${paths.join(", ")}`);
  }

  return content.split("\n");
}
