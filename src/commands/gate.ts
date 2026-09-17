import { advance, gateArtifacts } from "../run/orchestrator.ts";
import { PHASES, phaseForGate } from "../run/phases.ts";
import {
  appendApproval,
  appendContestation,
  hashArtifact,
  readArtifact,
  readLedger,
  readState,
  writeArtifact,
  writeLedger,
  writeState,
  type GateId,
} from "../run/store.ts";
import { parsePlanUnits } from "../run/plan-parser.ts";
import type { VerifyFinding } from "../run/runner.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface GateOptions extends RunSelector {
  gate: string;
}

export interface RejectOptions extends GateOptions {
  to: string;
  reason: string;
}

export interface ContestationOptions extends RunSelector {
  unit: string;
  layer: string;
}

function parseGate(value: string): GateId {
  const gate = value.trim().toLowerCase();
  if (gate !== "verify") {
    throw new Error(`No gate "${value}". The only gate is "verify".`);
  }
  return gate as GateId;
}

export async function runApprove(options: GateOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const def = phaseForGate(gate)!;
  const sha = await hashArtifact(run, def.output);
  if (!sha) {
    throw new Error(`${gate} has nothing to approve — ${def.title} has not written ${def.output} yet`);
  }

  const artifacts = await gateArtifacts(run);

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "approve",
    artifacts,
  });

  return [
    `verify approved (${artifacts.length} artifact(s))`,
    "",
    ...(await advance(run)),
  ];
}

export async function runReject(options: RejectOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const targetId = options.to.trim().toLowerCase();
  const target = PHASES.find((p) => p.id === targetId);
  if (!target) {
    throw new Error(
      `Cannot re-enter at "${options.to}". Valid phases: ${PHASES.map((p) => p.id).join(", ")}`
    );
  }

  if (!options.reason.trim()) {
    throw new Error("A rejection needs a reason.");
  }

  const artifacts = await gateArtifacts(run);

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "reject",
    reason: options.reason,
    artifacts,
  });

  const state = await readState(run);
  const reentered = PHASES.slice(PHASES.findIndex((p) => p.id === target.id)).map((p) => p.id);

  await writeState(run, {
    ...state,
    phase: target.id,
    status: "pending",
    gate: undefined,
    rerun: true,
    completed: state.completed.filter((id) => !reentered.includes(id)),
    note: `verify rejected to ${target.title}`,
  });

  if (target.id === "build") {
    const ledger = await readLedger(run);
    if (ledger) {
      const units = await parsePlanUnits(run);
      const raw = await readArtifact(run, "verify.json");
      const findings: VerifyFinding[] = raw
        ? (JSON.parse(raw).findings ?? [])
        : [];

      const findingFiles = new Set(findings.map((f) => f.file).filter(Boolean));
      const implicated = findingFiles.size > 0
        ? units.filter((u) => u.files.some((f) => findingFiles.has(f)))
        : units;  // all units if no finding names a file

      const implicatedIds = new Set(implicated.map((u) => u.id));
      for (const entry of ledger.units) {
        if (!implicatedIds.has(entry.unit)) continue;
        entry.fenceViolations = [];
        for (const layer of entry.layers) {
          layer.status = "pending";
          layer.reason = undefined;
        }
      }
      await writeLedger(run, ledger);

      // Write rejection.md
      const rejLines = [`# Rejection\n`, options.reason, "", "## Findings", ""];
      for (const f of findings) {
        rejLines.push(`- \`${f.file}\`: ${f.what} → ${f.actual}`);
      }
      await writeArtifact(run, "rejection.md", rejLines.join("\n") + "\n");
    }
  }

  return [
    `verify rejected — re-entering at ${target.title}`,
    `  reason  ${options.reason}`,
  ];
}

function findLayer(ledger: Awaited<ReturnType<typeof readLedger>>, unit: string, layer: string) {
  if (!ledger) throw new Error("No ledger.json — nothing to resolve.");
  const entry = ledger.units.find((u) => u.unit === unit);
  if (!entry) throw new Error(`No unit "${unit}" in the ledger. Units: ${ledger.units.map((u) => u.unit).join(", ")}`);
  const report = entry.layers.find((l) => l.layer === layer);
  if (!report) throw new Error(`No layer "${layer}" in ${unit}. Layers: ${entry.layers.map((l) => l.layer).join(", ")}`);
  return { entry, report };
}

export async function runOverride(options: ContestationOptions): Promise<string[]> {
  const run = await selectRun(options);
  const ledger = await readLedger(run);
  const { report } = findLayer(ledger, options.unit, options.layer);

  if (report.status !== "contested") {
    throw new Error(`${options.unit}/${options.layer} is "${report.status}", not contested.`);
  }

  report.status = "pending";
  report.reason = undefined;
  report.suppressContestation = true;
  await writeLedger(run, ledger!);

  await appendContestation(run, {
    ts: new Date().toISOString(),
    unit: options.unit,
    layer: options.layer,
    decision: "override",
  });

  // Reset run to build phase so the layer can be re-dispatched
  const state = await readState(run);
  if (state.status === "awaiting_gate" || state.status === "failed") {
    await writeState(run, {
      ...state,
      phase: "build",
      status: "pending",
      gate: undefined,
      rerun: true,
      note: `Override: ${options.unit}/${options.layer} reset to pending`,
    });
  }

  return [
    `${options.unit}/${options.layer} overridden — reset to pending.`,
    `\`valtay run <spec>\` to re-dispatch.`,
  ];
}

export async function runAcceptLayer(options: ContestationOptions): Promise<string[]> {
  const run = await selectRun(options);
  const ledger = await readLedger(run);
  const { report } = findLayer(ledger, options.unit, options.layer);

  if (report.status !== "contested") {
    throw new Error(`${options.unit}/${options.layer} is "${report.status}", not contested.`);
  }

  report.status = "done";
  report.reason = undefined;
  await writeLedger(run, ledger!);

  await appendContestation(run, {
    ts: new Date().toISOString(),
    unit: options.unit,
    layer: options.layer,
    decision: "accept",
  });

  // Check if all layers are now done and update state accordingly
  const allLayers = ledger!.units.flatMap((u) => u.layers);
  const allDone = allLayers.every((l) => l.status === "done");

  const state = await readState(run);
  if (allDone && (state.status === "awaiting_gate" || state.status === "failed")) {
    await writeState(run, {
      ...state,
      phase: "build",
      status: "pending",
      gate: undefined,
      note: `Accept: all contestations resolved`,
    });
  } else if (state.status === "awaiting_gate" || state.status === "failed") {
    await writeState(run, {
      ...state,
      phase: "build",
      status: "pending",
      gate: undefined,
      rerun: true,
      note: `Accept: ${options.unit}/${options.layer} exempted`,
    });
  }

  return [
    `${options.unit}/${options.layer} accepted — marked done by exemption.`,
    ...(allDone ? ["`valtay run <spec>` to continue."] : ["Other layers remain. Resolve them, then `valtay run <spec>`."]),
  ];
}
