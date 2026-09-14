import { resolve } from "path";
import { homedir } from "os";
import type { Runspec } from "./runspec.ts";
import type { PhaseId } from "./run/store.ts";

/** Extract top-level `key = "value"` pairs from a TOML file. Ignores tables. */
function parseSimpleToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inTable = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { inTable = true; continue; }
    if (inTable) continue; // skip table contents
    const match = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

export interface PhaseBinding {
  host: string;
  model: string;
  effort?: string;
}

export interface ResolvedConfig {
  default: PhaseBinding;
  phases: Partial<Record<PhaseId, Partial<PhaseBinding>>>;
  retries: number;
}

/**
 * Valtay's own directory — `~/.valtay` unless `VALTAY_HOME` overrides it.
 */
export function valtayHome(): string {
  return process.env["VALTAY_HOME"] || resolve(homedir(), ".valtay");
}

/**
 * Resolves config. Precedence: runspec frontmatter → valtay.toml → built-in defaults.
 */
export function resolveConfig(spec: Runspec, repoRoot?: string): ResolvedConfig {
  const fm = spec.frontmatter;

  // Read valtay.toml as fallback if repoRoot provided
  let toml: Record<string, string> = {};
  if (repoRoot) {
    try {
      const content = require("fs").readFileSync(resolve(repoRoot, "valtay.toml"), "utf-8");
      toml = parseSimpleToml(content);
    } catch { /* no toml or unreadable — fine */ }
  }

  const defaultBinding: PhaseBinding = {
    host: typeof fm["host"] === "string" ? fm["host"] : (toml["host"] ?? "claude"),
    model: typeof fm["model"] === "string" ? fm["model"] : (toml["model"] ?? "sonnet"),
    ...(typeof fm["effort"] === "string" ? { effort: fm["effort"] } : (toml["effort"] ? { effort: toml["effort"] } : {})),
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

  const retries = typeof fm["retries"] === "number" ? fm["retries"] : 1;

  return { default: defaultBinding, phases, retries };
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
