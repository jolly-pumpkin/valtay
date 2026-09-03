import { readArtifact } from "../run/store.ts";
import { renderTrace, renderTree, type ProbeResult, type Trace } from "../trace.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface TraceOptions extends RunSelector {
  /** Release unit to render. Optional when the probe produced only one. */
  unit?: string;
  /** Render the nested tree instead of the flat `path:line:col` list. */
  tree?: boolean;
}

async function probeResult(options: TraceOptions): Promise<ProbeResult> {
  const run = await selectRun(options);

  const stored = await readArtifact(run, "probe.json");
  if (stored === null) throw new Error("No probe.json in this run — the probe has not run yet");

  return JSON.parse(stored) as ProbeResult;
}

function pick(traces: Trace[], unit?: string): Trace {
  if (unit) {
    const found = traces.find((t) => t.unit.toLowerCase() === unit.toLowerCase());
    if (!found) {
      throw new Error(`No trace for ${unit}. Units: ${traces.map((t) => t.unit).join(", ")}`);
    }
    return found;
  }

  if (traces.length !== 1) {
    throw new Error(`This run has ${traces.length} traces. Name one: ${traces.map((t) => t.unit).join(", ")}`);
  }
  return traces[0]!;
}

/**
 * Renders one unit's trace.
 *
 * The flat form is the default because it is what every target consumes: a terminal
 * makes `path:line:col` ctrl-clickable for free, and an editor's problem matcher
 * turns the same text into a list you can walk with one keystroke. Navigation is the
 * finding — a decorated tree has no links.
 *
 * `--tree` is the summary and the phone view. It shows nesting, which the flat list
 * cannot, and that is its one advantage.
 */
export async function runTrace(options: TraceOptions): Promise<string[]> {
  const result = await probeResult(options);
  const trace = pick(result.traces, options.unit);

  const lines = options.tree ? renderTree(trace) : renderTrace(trace);

  // The reviewer must always know how much to trust the path. A Tier 3 trace that
  // looks authoritative and is wrong is worse than no trace at all.
  if (!options.tree) {
    lines.push("", `source: ${trace.source}${trace.source === "agent" ? " (advisory — cannot block)" : ""}`);
  }

  const deviations = [...(result.deviations ?? []), ...(trace.deviations ?? [])];
  if (deviations.length > 0) {
    lines.push("", `${deviations.length} deviation(s):`);
    for (const deviation of deviations) {
      const severity = deviation.severity ? `[${deviation.severity}] ` : "";
      const fix = deviation.fix_lives_in ? ` → fix lives in ${deviation.fix_lives_in}` : "";
      lines.push(`  ${severity}${deviation.kind}: ${deviation.detail}${fix}`);
    }
  }

  return lines;
}
