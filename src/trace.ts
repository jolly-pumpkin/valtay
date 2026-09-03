import type { ResolvedConfig } from "./config.ts";

export type TraceSource = "runtime" | "static" | "agent";
export type NodeStatus = "new" | "changed" | "unchanged";
export type Severity = "cosmetic" | "local" | "structural";

export interface TraceNode {
  id: string;
  symbol: string;
  file: string;
  line: number;
  /** Derived from the config's path→layer map when the trace does not carry one. */
  layer?: string;
  status: NodeStatus;
  /** The annotation. Inline by requirement — never a footnote (design.md §13.1). */
  note?: string | null;
  children: string[];
}

export interface Deviation {
  kind: string;
  detail: string;
  file?: string;
  /**
   * `structural` means the fix lives *above* the plan in the artifact chain — a
   * mechanical question about which file needs editing, which is why it can be
   * applied consistently (design.md §10.2).
   */
  severity?: Severity;
  /** Which artifact must change. Drives re-entry (design.md §10.4). */
  fix_lives_in?: string;
}

export interface Trace {
  unit: string;
  /** How much to trust the path. The reviewer must always be able to see this. */
  source: TraceSource;
  entry: string;
  nodes: TraceNode[];
  deviations?: Deviation[];
}

/** What the probe phase returns: one document the orchestrator splits. */
export interface ProbeResult {
  traces: Trace[];
  deviations: Deviation[];
  /**
   * The tail of what the unit's checkpoint actually printed.
   *
   * Evidence rather than assertion. A probe that reports a trace without having run
   * the oracle is reporting what it expected the code to do, which is the paragraph
   * the trace was supposed to replace — and it is fast enough to be easy to do by
   * accident. Requiring the output makes the gate one that will not open without it.
   */
  checkpoint_output?: string;
  notes?: string;
}

const STATUSES: readonly NodeStatus[] = ["new", "changed", "unchanged"];
const SOURCES: readonly TraceSource[] = ["runtime", "static", "agent"];

/** Sign encoding rather than colour — colour is unreliable across terminals. */
const SIGN: Record<NodeStatus, string> = { new: "+", changed: "~", unchanged: "-" };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The layer a file belongs to, from the config's path→layer map.
 *
 * Layer exists so the renderer can put it in a fixed-width column, which turns a
 * layering violation — a `ui` node downstream of a `game` node — into something that
 * pops out rather than something the reviewer must remember to check for.
 */
export function layerFor(file: string, layers: Record<string, string>): string | undefined {
  for (const [pattern, layer] of Object.entries(layers)) {
    if (new Bun.Glob(pattern).match(file)) return layer;
  }
  return undefined;
}

function nodeProblems(node: unknown, where: string, ids: Set<string>): string[] {
  if (!isTable(node)) return [`${where} is not an object`];

  const problems: string[] = [];
  const id = typeof node["id"] === "string" ? node["id"] : null;
  if (!id) problems.push(`${where} has no id`);

  const at = `node ${id ?? where}`;
  if (typeof node["symbol"] !== "string") problems.push(`${at} has no symbol`);
  if (typeof node["file"] !== "string") problems.push(`${at} has no file`);
  if (typeof node["line"] !== "number") problems.push(`${at} has no line number`);

  if (!STATUSES.includes(node["status"] as NodeStatus)) {
    problems.push(`${at} has status ${JSON.stringify(node["status"])} — expected new, changed or unchanged`);
  }

  const children = node["children"];
  if (children !== undefined && !Array.isArray(children)) {
    problems.push(`${at} has non-array children`);
  } else if (Array.isArray(children)) {
    for (const child of children) {
      if (!ids.has(String(child))) problems.push(`${at} points at missing child ${child}`);
    }
  }

  return problems;
}

/**
 * Everything wrong with a trace. Empty means it is well-formed.
 *
 * The node cap is not a style rule. Working memory holds three to five chunks, so a
 * trace you cannot hold is a trace you cannot review — which makes the renderer's
 * limit the planner's constraint too, and gives slice-sizing an objective test.
 */
export function validateTrace(parsed: unknown, config: ResolvedConfig): string[] {
  if (!isTable(parsed)) return ["the trace is not a JSON object"];

  const problems: string[] = [];
  if (typeof parsed["unit"] !== "string") problems.push("no unit");
  if (typeof parsed["entry"] !== "string") problems.push("no entry point");

  if (!SOURCES.includes(parsed["source"] as TraceSource)) {
    problems.push(
      `source is ${JSON.stringify(parsed["source"])} — expected runtime, static or agent, ` +
        "and the reviewer must be able to see how much to trust the path"
    );
  }

  const nodes = parsed["nodes"];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    problems.push("no nodes");
    return problems;
  }

  const ids = new Set(nodes.filter(isTable).map((n) => String(n["id"])));
  nodes.forEach((node, i) => problems.push(...nodeProblems(node, `nodes[${i}]`, ids)));

  if (nodes.length > config.run.max_trace_nodes) {
    problems.push(
      `${nodes.length} nodes exceeds the run budget of ${config.run.max_trace_nodes} — split the unit`
    );
  }

  return problems;
}

/** Fills in each node's layer from the config map, where the trace left it out. */
export function withLayers(trace: Trace, layers: Record<string, string>): Trace {
  return {
    ...trace,
    nodes: trace.nodes.map((node) => ({
      ...node,
      ...(node.layer ? {} : { layer: layerFor(node.file, layers) }),
    })),
  };
}

/**
 * Nodes in execution order, depth-first from the roots.
 *
 * Position encodes causality, which is the cheapest possible encoding to read — so
 * the order is the artifact, not a presentation choice.
 */
export function executionOrder(trace: Trace): TraceNode[] {
  const byId = new Map(trace.nodes.map((node) => [node.id, node]));
  const claimed = new Set(trace.nodes.flatMap((node) => node.children));
  const ordered: TraceNode[] = [];
  const seen = new Set<string>();

  const walk = (node: TraceNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    for (const id of node.children) {
      const child = byId.get(id);
      if (child) walk(child);
    }
  };

  for (const node of trace.nodes) if (!claimed.has(node.id)) walk(node);
  // A cycle, or a node no root reaches, still has to be visible.
  for (const node of trace.nodes) walk(node);

  return ordered;
}

/**
 * The default render: `path:line:col: message`, one entry per node.
 *
 * Machine-parseable on purpose. Every target consumes this form — a terminal makes
 * it ctrl-clickable for free, and an editor's problem matcher turns it into a list
 * you can walk with a keystroke. Navigation is the finding, and a decorated tree has
 * no links.
 */
export function renderTrace(trace: Trace): string[] {
  const nodes = executionOrder(trace);
  const width = Math.max(...nodes.map((n) => (n.layer ?? "").length), 0);

  return nodes.map((node) => {
    const layer = width > 0 ? ` [${(node.layer ?? "").padEnd(width)}]` : "";
    const note = node.note ? ` — ${node.note}` : "";
    return `${node.file}:${node.line}:1:${layer} ${SIGN[node.status]} ${node.symbol}${note}`;
  });
}

/**
 * The tree render: the summary, and the view for a phone.
 *
 * It shows nesting, which the flat list cannot. That is its one advantage and the
 * reason it survives at all — depth is legible here and invisible there.
 */
export function renderTree(trace: Trace): string[] {
  const byId = new Map(trace.nodes.map((node) => [node.id, node]));
  const claimed = new Set(trace.nodes.flatMap((node) => node.children));
  const deviations = trace.deviations?.length ?? 0;

  const lines = [
    `${trace.unit}  ${trace.nodes.length} nodes · ${deviations} deviation(s) · source: ${trace.source}`,
    "",
  ];

  const seen = new Set<string>();
  const walk = (node: TraceNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);

    const indent = "   ".repeat(depth);
    const arrow = depth === 0 ? "" : "└→ ";
    const layer = node.layer ? `  [${node.layer}]` : "";
    lines.push(`${indent}${arrow}${node.symbol}  ${SIGN[node.status]}${layer}`);

    // The annotation sits with the node it annotates. Splitting a diagram from its
    // explanation imposes an integration cost that can erase the benefit of having
    // the diagram at all (design.md §13.1).
    if (node.note) lines.push(`${indent}${depth === 0 ? "" : "   "}   ${node.note}`);

    for (const id of node.children) {
      const child = byId.get(id);
      if (child) walk(child, depth + 1);
    }
  };

  for (const node of trace.nodes) if (!claimed.has(node.id)) walk(node, 0);
  for (const node of trace.nodes) walk(node, 0);

  return lines;
}
