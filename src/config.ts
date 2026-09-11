import { resolve } from "path";
import { homedir } from "os";
import type { Runspec } from "./runspec.ts";
import type { PhaseId } from "./run/store.ts";

export interface PhaseBinding {
  host: string;
  model: string;
  effort?: string;
}

export interface ResolvedConfig {
  default: PhaseBinding;
  phases: Partial<Record<PhaseId, Partial<PhaseBinding>>>;
  run?: { max_units?: number; max_layers?: number };
  retries: number;
}

/**
 * Valtay's own directory — `~/.valtay` unless `VALTAY_HOME` overrides it.
 */
export function valtayHome(): string {
  return process.env["VALTAY_HOME"] || resolve(homedir(), ".valtay");
}

/**
 * Resolves config from the runspec frontmatter only.
 * No valtay.toml merge for MVP.
 */
export function resolveConfig(spec: Runspec): ResolvedConfig {
  const fm = spec.frontmatter;

  const defaultBinding: PhaseBinding = {
    host: typeof fm["host"] === "string" ? fm["host"] : "claude",
    model: typeof fm["model"] === "string" ? fm["model"] : "sonnet",
    ...(typeof fm["effort"] === "string" ? { effort: fm["effort"] } : {}),
  };

  const phases: ResolvedConfig["phases"] = {};
  const phasesRaw = fm["phases"];
  if (phasesRaw && typeof phasesRaw === "object" && !Array.isArray(phasesRaw)) {
    for (const [key, val] of Object.entries(phasesRaw as Record<string, unknown>)) {
      if (key === "plan" || key === "build" || key === "verify") {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const v = val as Record<string, unknown>;
          phases[key] = {
            ...(typeof v["host"] === "string" ? { host: v["host"] } : {}),
            ...(typeof v["model"] === "string" ? { model: v["model"] } : {}),
            ...(typeof v["effort"] === "string" ? { effort: v["effort"] } : {}),
          };
        }
      }
    }
  }

  let run: ResolvedConfig["run"];
  const runRaw = fm["run_budget"] ?? fm["run"];
  if (runRaw && typeof runRaw === "object" && !Array.isArray(runRaw)) {
    const r = runRaw as Record<string, unknown>;
    run = {
      ...(typeof r["max_units"] === "number" ? { max_units: r["max_units"] } : {}),
      ...(typeof r["max_layers"] === "number" ? { max_layers: r["max_layers"] } : {}),
    };
  }

  const retries = typeof fm["retries"] === "number" ? fm["retries"] : 1;

  return { default: defaultBinding, phases, run, retries };
}

/** Resolve the binding for a specific phase, with defaults filled in. */
export function bindingFor(config: ResolvedConfig, phase: PhaseId): PhaseBinding {
  const override = config.phases[phase] ?? {};
  return {
    host: override.host ?? config.default.host,
    model: override.model ?? config.default.model,
    effort: override.effort ?? config.default.effort,
  };
}
