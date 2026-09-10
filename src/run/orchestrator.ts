import { PHASES, nextPhase, phase } from "./phases.ts";
import {
  hashArtifact,
  readArtifact,
  readState,
  writeState,
  type ArtifactRef,
  type Run,
} from "./store.ts";

/**
 * Verify artifact schema: what the verify skill writes to `verify.json`.
 */
interface VerifyResult {
  status: "clean" | "drift";
  findings?: Array<{
    what: string;
    actual: string;
    file: string;
    severity: "drift" | "minor";
  }>;
}

/**
 * Every artifact produced up to and including the current phase.
 * Used for approval binding.
 */
export async function gateArtifacts(run: Run): Promise<ArtifactRef[]> {
  const refs = await Promise.all(
    PHASES.map(async (p) => {
      const sha = await hashArtifact(run, p.output);
      return sha === null ? null : { path: p.output, sha };
    })
  );
  return refs.filter((ref): ref is ArtifactRef => ref !== null);
}

/**
 * Advances the run by checking artifacts on disk.
 *
 * The orchestrator never invokes phases — it only watches for artifacts the
 * human placed by running skills in their interactive session.
 *
 * - plan artifact exists → advance to build
 * - build artifact exists → advance to verify
 * - verify artifact exists and clean → complete
 * - verify artifact exists and drift → park, show findings to human
 */
export async function advance(run: Run): Promise<string[]> {
  const lines: string[] = [];

  for (;;) {
    const state = await readState(run);

    if (state.status === "complete") {
      lines.push("Run complete.");
      return lines;
    }

    if (state.status === "failed") {
      lines.push(`Run failed.${state.note ? ` ${state.note}` : ""}`);
      return lines;
    }

    const def = phase(state.phase);
    const artifactExists = (await hashArtifact(run, def.output)) !== null;

    if (!artifactExists) {
      lines.push(`Waiting for ${def.title} artifact: ${def.output}`);
      lines.push(`Run the ${def.id} skill in your coding session, then \`valtay advance\`.`);
      await writeState(run, { ...state, status: "pending" });
      return lines;
    }

    // Artifact exists — check the gate
    if (def.gate === "verify") {
      const raw = await readArtifact(run, def.output);
      if (!raw) {
        lines.push(`Could not read ${def.output}.`);
        return lines;
      }

      let result: VerifyResult;
      try {
        result = JSON.parse(raw) as VerifyResult;
      } catch {
        await writeState(run, {
          ...state,
          status: "failed",
          note: `${def.output} is not valid JSON`,
        });
        lines.push(`${def.output} is not valid JSON.`);
        return lines;
      }

      if (result.status === "clean") {
        lines.push("Verify: clean. No drift detected.");
        await writeState(run, {
          ...state,
          status: "complete",
          completed: [...state.completed, def.id],
        });
        lines.push("Run complete.");
        return lines;
      }

      // Drift — park and show findings
      const driftCount = result.findings?.filter((f) => f.severity === "drift").length ?? 0;
      const note = `Verify found ${driftCount} drift finding(s). Review with \`valtay show verify.json\`, then \`valtay approve verify\` or fix and re-verify.`;

      await writeState(run, {
        ...state,
        status: "awaiting_gate",
        gate: "verify",
        note,
      });

      lines.push(`Verify: drift detected (${driftCount} finding(s)).`);
      if (result.findings) {
        for (const f of result.findings) {
          lines.push(`  ${f.severity}: ${f.what} — ${f.file}`);
        }
      }
      lines.push("");
      lines.push(`\`valtay approve verify\` to accept, or fix and re-run the verify skill.`);
      return lines;
    }

    // No gate (plan, build) — auto-advance
    lines.push(`${def.title}: artifact found (${def.output}), advancing.`);
    const completed = state.completed.includes(def.id)
      ? state.completed
      : [...state.completed, def.id];

    const next = nextPhase(def.id);
    if (!next) {
      await writeState(run, { ...state, status: "complete", completed });
      lines.push("Run complete.");
      return lines;
    }

    await writeState(run, {
      phase: next.id,
      status: "pending",
      completed,
      updated: state.updated,
    });
  }
}
