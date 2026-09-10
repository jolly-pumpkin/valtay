import { PHASES } from "../run/phases.ts";
import { readArtifact } from "../run/store.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface ShowOptions extends RunSelector {
  artifact: string;
}

export async function runShow(options: ShowOptions): Promise<string[]> {
  const run = await selectRun(options);

  const wanted = options.artifact.trim().toLowerCase();
  const paths = PHASES.map((p) => p.output);
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
