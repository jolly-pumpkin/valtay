import { resolve } from "path";
import { homedir } from "os";
import { pathExists } from "./detect.ts";
import { checkPredicate } from "./gates.ts";
import type { Runspec } from "./runspec.ts";

/**
 * Every role design.md §5 names. Only a subset runs in the current pipeline —
 * `assessor`, `warden` and `critic` are bindable but not yet invoked — because a
 * binding that exists in config before the phase does is harmless, while a phase
 * that arrives to find no binding is a run-time failure.
 */
export const ROLES = [
  "researcher",
  "designer",
  "shaper",
  "planner",
  "prober",
  "assessor",
  "warden",
  "builder",
  "critic",
] as const;

export type Role = (typeof ROLES)[number];
export type TraceTier = "runtime" | "static" | "agent";

export interface HostDef {
  bin: string;
  adapter: string;
}

export interface RoleBinding {
  /** Key into `ResolvedConfig.hosts`. */
  host: string;
  /** Opaque. Valtay never validates, maps or normalizes it (invariant 4). */
  model: string;
  effort?: string;
  timeout_ms: number;
}

export interface ResolvedConfig {
  hosts: Record<string, HostDef>;
  roles: Record<Role, RoleBinding>;
  trace: { tier: TraceTier; command?: string };
  layers: Record<string, string>;
  run: { max_units: number; max_layers: number; max_trace_nodes: number };
  probe: { promote: boolean };
  /** Pre-authorization predicates, by gate ID. G1, G2 and G6 are never eligible. */
  gates: Record<string, { auto_pass_if?: string }>;
}

const BUILTIN_HOST: HostDef = { bin: "claude", adapter: "claude-code" };

const BUILTIN_DEFAULT_BINDING = {
  host: "claude-code",
  model: "sonnet",
  effort: "medium",
  timeout: "10m",
};

const BUILTIN_RUN = { max_units: 5, max_layers: 12, max_trace_nodes: 40 };

/**
 * Valtay's own directory — `~/.valtay` unless `VALTAY_HOME` overrides it.
 *
 * The override exists so a test (or a second machine's checkout) gets its own
 * config, phase prompts and run history instead of the developer's.
 */
export function valtayHome(): string {
  return process.env["VALTAY_HOME"] || resolve(homedir(), ".valtay");
}

export function userConfigPath(): string {
  return resolve(valtayHome(), "config.toml");
}

/** `10m` / `90s` / `2h` / a bare number of seconds, in milliseconds. */
export function parseDuration(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value * 1000;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) throw new Error(`Unparseable duration: ${value}`);

  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!;
  return Math.round(amount * scale);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isTable(value) ? value : {};
}

/** Later sources win, key by key. One level deep — every config section is flat. */
function overlay(...sources: Record<string, unknown>[]): Record<string, unknown> {
  return Object.assign({}, ...sources);
}

async function readToml(path: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(path))) return {};
  const parsed = Bun.TOML.parse(await Bun.file(path).text());
  if (!isTable(parsed)) throw new Error(`${path}: not a TOML table`);
  return parsed;
}

/**
 * Resolves a host reference to a key in `hosts`.
 *
 * Accepts either the table key (`claude-code`, as design.md §6.1 writes it) or the
 * binary name (`claude`, as the RUNSPEC.md example writes it) so both spellings in
 * the docs work without an alias table to keep in sync.
 */
function resolveHostName(name: string, hosts: Record<string, HostDef>): string {
  if (name in hosts) return name;

  const byBin = Object.entries(hosts).find(([, host]) => host.bin === name);
  if (byBin) return byBin[0];

  throw new Error(`Unknown host "${name}". Configured hosts: ${Object.keys(hosts).join(", ")}`);
}

function resolveHosts(sources: Record<string, unknown>[]): Record<string, HostDef> {
  const merged = overlay(...sources.map((s) => table(s, "hosts")));

  const hosts: Record<string, HostDef> = {};
  for (const [name, def] of Object.entries(merged)) {
    if (!isTable(def)) continue;
    const bin = typeof def["bin"] === "string" ? def["bin"] : name;
    const adapter = typeof def["adapter"] === "string" ? def["adapter"] : name;
    hosts[name] = { bin, adapter };
  }

  return Object.keys(hosts).length > 0 ? hosts : { "claude-code": BUILTIN_HOST };
}

function resolveRoles(
  sources: Record<string, unknown>[],
  hosts: Record<string, HostDef>
): Record<Role, RoleBinding> {
  const roleTables = sources.map((s) => table(s, "roles"));
  const fallbackName = Object.keys(hosts)[0]!;

  const defaults = overlay(
    { ...BUILTIN_DEFAULT_BINDING, host: fallbackName },
    ...roleTables.map((t) => (isTable(t["default"]) ? t["default"] : {}))
  );

  const roles = {} as Record<Role, RoleBinding>;
  for (const role of ROLES) {
    const merged = overlay(
      defaults,
      ...roleTables.map((t) => (isTable(t[role]) ? (t[role] as Record<string, unknown>) : {}))
    );

    roles[role] = {
      host: resolveHostName(String(merged["host"]), hosts),
      model: String(merged["model"]),
      ...(merged["effort"] === undefined ? {} : { effort: String(merged["effort"]) }),
      timeout_ms: parseDuration(merged["timeout"] as string | undefined, 600_000),
    };
  }

  return roles;
}

function resolveRun(sources: Record<string, unknown>[]): ResolvedConfig["run"] {
  // `[run]` in valtay.toml, `run_budget:` in a run spec — same three numbers.
  const merged = overlay(
    BUILTIN_RUN,
    ...sources.flatMap((s) => [table(s, "run"), table(s, "run_budget")])
  );

  return {
    max_units: Number(merged["max_units"]),
    max_layers: Number(merged["max_layers"]),
    max_trace_nodes: Number(merged["max_trace_nodes"]),
  };
}

function resolveTrace(sources: Record<string, unknown>[]): ResolvedConfig["trace"] {
  const merged = overlay({ tier: "agent" }, ...sources.map((s) => table(s, "trace")));

  const tier = String(merged["tier"]);
  if (tier !== "runtime" && tier !== "static" && tier !== "agent") {
    throw new Error(`Unknown trace tier "${tier}" — expected runtime, static or agent`);
  }

  const command = merged["command"];
  return {
    tier,
    ...(typeof command === "string" && command.trim() ? { command } : {}),
  };
}

/**
 * Gate pre-authorization predicates, checked rather than trusted.
 *
 * Every failure here is one a human can only have made by hand, so it belongs at
 * `valtay start` while they are still watching — not four phases later at a gate that
 * quietly refuses to open. An ineligible gate, an unknown gate, an unparseable
 * expression and a mistyped variable all stop the run before it begins.
 */
function resolveGates(sources: Record<string, unknown>[]): ResolvedConfig["gates"] {
  const merged = overlay(...sources.map((s) => table(s, "gates")));

  const gates: ResolvedConfig["gates"] = {};
  for (const [name, def] of Object.entries(merged)) {
    if (!isTable(def)) continue;

    const predicate = def["auto_pass_if"];
    if (predicate === undefined) continue;
    if (typeof predicate !== "string") {
      throw new Error(`${name} auto_pass_if must be a string, not ${typeof predicate}`);
    }

    const gate = name.trim().toUpperCase();
    checkPredicate(gate, predicate);
    gates[gate] = { auto_pass_if: predicate };
  }

  return gates;
}

/**
 * Merges every config source into one frozen binding set.
 *
 * Precedence, most specific first (design.md §20):
 *   run spec frontmatter -> ./valtay.toml -> ~/.valtay/config.toml -> built-in
 *
 * Resolved once at `valtay start` and written into the manifest, so a later edit to
 * any source cannot silently change what a mid-flight run is doing.
 */
export async function resolveConfig(
  repoRoot: string,
  spec?: Runspec
): Promise<ResolvedConfig> {
  const sources: Record<string, unknown>[] = [
    await readToml(userConfigPath()),
    await readToml(resolve(repoRoot, "valtay.toml")),
  ];
  if (spec) sources.push(spec.frontmatter);

  const hosts = resolveHosts(sources);

  return {
    hosts,
    roles: resolveRoles(sources, hosts),
    trace: resolveTrace(sources),
    layers: overlay(...sources.map((s) => table(s, "layers"))) as Record<string, string>,
    run: resolveRun(sources),
    probe: { promote: table(sources.at(-1) ?? {}, "probe")["promote"] === true },
    gates: resolveGates(sources),
  };
}

/**
 * Whether any two roles are bound to different hosts.
 *
 * design.md invariant 9 — whoever produced an artifact does not grade it — is a
 * claim about vendors, so a run where every role resolves to one host cannot honor
 * it. Recorded in the manifest rather than enforced, so single-host runs stay
 * distinguishable from cross-vendor ones when the results are compared later.
 */
export function vendorDiversity(config: ResolvedConfig): boolean {
  return new Set(Object.values(config.roles).map((b) => b.host)).size > 1;
}
