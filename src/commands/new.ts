import { resolve, basename } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { detectSkills } from "../detect.ts";

interface NewArgs {
  name: string;
  repo: string;
  tickets: string[];
  mode: "attended" | "unattended";
  commit: boolean;
}

function parseArgs(args: string[]): NewArgs | null {
  if (args.length === 0) return null;

  const name = args[0]!;
  if (name.startsWith("-")) return null;

  let repo = ".";
  let tickets: string[] = [];
  let mode: "attended" | "unattended" = "attended";
  let commit = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo" && args[i + 1]) {
      repo = args[++i]!;
    } else if (arg === "--tickets" && args[i + 1]) {
      tickets = args[++i]!.split(",").map((t) => t.trim());
    } else if (arg === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m === "attended" || m === "unattended") mode = m;
    } else if (arg === "--commit") {
      commit = true;
    }
  }

  return { name, repo: resolve(repo), tickets, mode, commit };
}

interface TomlDefaults {
  roles: string;
  trace: string;
  layers: string;
  plan: string;
}

function readTomlDefaults(repoPath: string): TomlDefaults | null {
  const tomlPath = resolve(repoPath, "valtay.toml");
  if (!existsSync(tomlPath)) return null;
  try {
    const content = readFileSync(tomlPath, "utf-8");
    return { roles: "", trace: "", layers: "", plan: "", ...parseTomlSections(content) };
  } catch {
    return null;
  }
}

function parseTomlSections(content: string): Partial<TomlDefaults> {
  const result: Partial<TomlDefaults> = {};
  const lines = content.split("\n");
  let currentSection = "";
  let sectionLines: string[] = [];

  const flush = () => {
    if (currentSection && sectionLines.length > 0) {
      const key = currentSection.replace(/^.*\./, "") as keyof TomlDefaults;
      if (key in ({ roles: 1, trace: 1, layers: 1, plan: 1 } as const)) {
        result[key] = sectionLines.join("\n");
      }
    }
  };

  for (const line of lines) {
    const sectionMatch = line.match(/^\[(.+)\]/);
    if (sectionMatch) {
      flush();
      currentSection = sectionMatch[1]!;
      sectionLines = [];
    } else if (line.trim()) {
      sectionLines.push(line);
    }
  }
  flush();
  return result;
}

function generateRunspec(args: NewArgs, tomlDefaults: TomlDefaults | null, skills: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const repoPath = args.repo;

  const ticketYaml =
    args.tickets.length > 0
      ? `[${args.tickets.join(", ")}]`
      : "[] # TODO: add ticket IDs";

  const rolesBlock = tomlDefaults?.roles
    ? `  # Defaults from valtay.toml — override per role as needed\n  # TODO: review and adjust role bindings`
    : `  # TODO: configure role bindings\n  # example: researcher: { host: claude, model: opus, effort: high }`;

  const skillsBlock =
    skills.length > 0
      ? skills
          .map(
            (s) =>
              `  - name: ${s}\n    path: # TODO\n    used_by: [] # TODO\n    provides: # TODO`
          )
          .join("\n")
      : `  # TODO: add skills\n  # - name: <skill-name>\n  #   path: <path>\n  #   used_by: [<role>, ...]\n  #   provides: tests | oracle | lint`;

  const traceBlock = tomlDefaults?.trace
    ? `  # Defaults from valtay.toml`
    : `  tier: agent # TODO: runtime | static | agent\n  command: "# TODO: trace command with {scenario} placeholder"`;

  const layersBlock = tomlDefaults?.layers
    ? `  # Defaults from valtay.toml`
    : `  # TODO: map path globs to layer names\n  # "src/ui/**": ui\n  # "src/game/**": game`;

  const planBlock = tomlDefaults?.plan
    ? `  # Defaults from valtay.toml`
    : `  stacking: none # TODO: gh-stack | graphite | none\n  max_semantic_loc: 400\n  max_teams_per_layer: 2\n  max_multiteam_per_unit: 1`;

  const ticketEntries =
    args.tickets.length > 0
      ? args.tickets.map((t) => `**${t} — TODO: title**\nTODO: one-line summary\n`).join("\n")
      : `**TODO — ticket title**\nTODO: one-line summary\n`;

  return `---
run: ${args.name}
repo: ${repoPath}
created: ${today}
mode: ${args.mode}

sources:
  prd:     # TODO: path or link to PRD
  design:  # TODO: path or link to tech design (Reconcile writes one if absent)
  epic:    # TODO: tracker epic ID
  tickets: ${ticketYaml}

roles:
${rolesBlock}

skills:
${skillsBlock}

trace:
${traceBlock}

layers:
${layersBlock}

plan:
${planBlock}

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

export function runNew(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error("Usage: valtay new <name> --repo <path> --tickets T-1,T-2 [--mode attended|unattended] [--commit]");
    process.exit(1);
  }

  const tomlDefaults = readTomlDefaults(parsed.repo);
  const skills = detectSkills(parsed.repo);

  const content = generateRunspec(parsed, tomlDefaults, skills);

  let outPath: string;
  if (parsed.commit) {
    outPath = resolve(parsed.repo, "runspec.md");
  } else {
    const repoName = basename(parsed.repo);
    const dir = resolve(
      process.env["HOME"] || "~",
      ".valtay",
      "runs",
      repoName,
      parsed.name
    );
    mkdirSync(dir, { recursive: true });
    outPath = resolve(dir, "runspec.md");
  }

  writeFileSync(outPath, content, "utf-8");
  console.log(`Created ${outPath}`);

  if (skills.length > 0) {
    console.log(`Detected agent config: ${skills.join(", ")}`);
  }
  if (tomlDefaults) {
    console.log("Applied defaults from valtay.toml");
  }
}
