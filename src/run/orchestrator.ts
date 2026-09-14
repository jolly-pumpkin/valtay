import { PHASES, nextPhase, phase } from "./phases.ts";
import {
  hashArtifact,
  isApproved,
  readArtifact,
  readLedger,
  readRetryState,
  readState,
  writeLedger,
  writeRetryState,
  writeState,
  type ArtifactRef,
  type BuildLedger,
  type LayerReport,
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

      // Drift — check if already approved before parking
      if (await isApproved(run, "verify")) {
        lines.push("Verify: drift detected but approved. Completing run.");
        await writeState(run, {
          ...state,
          status: "complete",
          completed: [...state.completed, def.id],
        });
        lines.push("Run complete.");
        return lines;
      }

      // Not approved — park and show findings
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
      lines.push(`\`valtay approve verify\` to accept, or fix and re-verify.`);
      return lines;
    }

    // Build phase: check ledger completeness before advancing
    if (def.id === "build") {
      const ledger = await readLedger(run);
      if (ledger) {
        const allLayers = ledger.units.flatMap((u) => u.layers);
        const contested = allLayers.filter((l) => l.status === "contested");
        const blocked = allLayers.filter((l) => l.status === "blocked");
        const pending = allLayers.filter((l) => l.status === "pending");
        const allDone = allLayers.length > 0 && allLayers.every((l) => l.status === "done");

        if (contested.length > 0) {
          const reasons = contested
            .map((l) => `  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason given)"}`)
            .join("\n");
          const note = `Build contested. ${contested.length} layer(s) contested by builder:\n${reasons}`;
          await writeState(run, {
            ...state,
            status: "awaiting_gate",
            note,
          });
          lines.push(`Build: ${contested.length} layer(s) contested.`);
          for (const l of contested) {
            lines.push(`  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason given)"}`);
          }
          lines.push("");
          lines.push("`valtay accept <unit> <layer>` or `valtay override <unit> <layer>` to resolve.");
          return lines;
        }

        if (blocked.length > 0) {
          const retryState = await readRetryState(run);
          const attempt = retryState ? retryState.attempt : 0;
          const max = run.meta.config.retries;

          if (attempt < max) {
            const nextAttempt = attempt + 1;
            const blockedIds = blocked.map((l) => `${l.unit}/${l.layer}`);
            const history = retryState?.history ?? [];
            await writeRetryState(run, {
              attempt: nextAttempt,
              max,
              history: [...history, { attempt: nextAttempt, blocked: blockedIds }],
            });
            await writeState(run, {
              ...state,
              status: "pending",
              rerun: true,
            });
            lines.push(`Build: ${blocked.length} layer(s) blocked. Retry ${nextAttempt}/${max}.`);
            for (const l of blocked) {
              lines.push(`  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason given)"}`);
            }
            return lines;
          }

          const note = `Build halted. ${blocked.length} layer(s) blocked after ${max} retry attempt(s).`;
          await writeState(run, {
            ...state,
            status: "failed",
            note,
          });
          lines.push(note);
          for (const l of blocked) {
            lines.push(`  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason given)"}`);
          }
          return lines;
        }

        if (pending.length > 0) {
          lines.push(`Build: ${pending.length} layer(s) still pending. Waiting for subagents.`);
          await writeState(run, { ...state, status: "pending" });
          return lines;
        }

        if (!allDone) {
          // Ledger exists but has no layers — treat as no ledger
          // Fall through to auto-advance
        }
        // allDone: fall through to auto-advance to verify
      }
      // No ledger: fall through to auto-advance (backwards compat)
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
