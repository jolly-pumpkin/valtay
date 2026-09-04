import { resolve } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";

interface NewArgs {
  name: string;
  tickets: string[];
  mode: "attended" | "unattended";
}

function parseArgs(args: string[]): NewArgs | null {
  if (args.length === 0) return null;

  const name = args[0]!;
  if (name.startsWith("-")) return null;

  let tickets: string[] = [];
  let mode: "attended" | "unattended" = "attended";

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--tickets" && args[i + 1]) {
      tickets = args[++i]!.split(",").map((t) => t.trim());
    } else if (arg === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m === "attended" || m === "unattended") mode = m;
    }
  }

  return { name, tickets, mode };
}


function generateRunspec(args: NewArgs): string {
  const today = new Date().toISOString().slice(0, 10);

  const ticketYaml =
    args.tickets.length > 0
      ? `[${args.tickets.join(", ")}]`
      : "[] # TODO: add ticket IDs";

  const ticketEntries =
    args.tickets.length > 0
      ? args.tickets.map((t) => `**${t} — TODO: title**\nTODO: one-line summary\n`).join("\n")
      : `**TODO — ticket title**\nTODO: one-line summary\n`;

  return `---
run: ${args.name}
created: ${today}
mode: ${args.mode}

sources:
  prd:     # TODO: path or link to PRD
  design:  # TODO: path or link to tech design (Reconcile writes one if absent)
  epic:    # TODO: tracker epic ID
  tickets: ${ticketYaml}

run_budget:
  max_units: 5
  max_layers: 12
  max_trace_nodes: 40

gates:
  # TODO: pre-authorization predicates (G1, G2, G6 can never be pre-authorized)
  # G3: { auto_pass_if: "layers <= 4 and multiteam_layers <= 1 and new_flags == 0" }
---

# ${args.name}

## Intent

TODO: What you want to be true when this run ships. One paragraph.

## Tickets

${ticketEntries}
## Conflicts

<!-- Cross-document contradictions. Each gets an ID and a resolution. -->
<!-- Unresolved conflicts block \`valtay start\`. -->
- **C-1** TODO: describe conflict
  → **UNRESOLVED** — TODO: resolve or move to out-of-scope

## Gaps

<!-- Design coverage holes. Disposition: in-scope or out-of-scope. -->
- **G-1** TODO: describe gap → TODO: in scope | **out of scope**

## Assumptions to verify

<!-- The ONLY section Research receives. Frame as things to verify, not claims. -->
- **A-1** TODO: assumption to verify

## Out of scope

- TODO: explicit exclusions

## Notes

TODO: hints for the pipeline, or delete this section
`;
}

/**
 * Walks up from `start` to find the nearest directory containing a `valtay.toml`
 * (i.e. a valtay-initialized project). Returns null if none is found.
 */
function findInitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, "valtay.toml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function runNew(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error("Usage: valtay new <name> --tickets T-1,T-2 [--mode attended|unattended]");
    process.exit(1);
  }

  const root = findInitRoot(process.cwd());
  if (!root) {
    console.error("No valtay.toml found — run `valtay init` first.");
    process.exit(1);
  }

  const dir = resolve(root, ".valtay", "runs", parsed.name);
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, "runspec.md");

  const content = generateRunspec(parsed);
  writeFileSync(outPath, content, "utf-8");
  console.log(`Created ${outPath}`);
}
