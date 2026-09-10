import { resolve } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";

function generateRunspec(name: string): string {
  const today = new Date().toISOString().slice(0, 10);

  return `---
run: ${name}
created: ${today}

host: claude
model: opus
effort: high

phases:
  plan:   { model: sonnet, effort: medium }
  build:  { model: opus,   effort: high }
  verify: { model: opus,   effort: high }
---

# ${name}

## Design

TODO: structures, interfaces, and intent — this IS the design

## Out of scope

TODO: explicit exclusions

## Notes

TODO: hints for the pipeline, or delete this section
`;
}

function findInitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, "valtay.toml")) || existsSync(resolve(dir, ".valtay"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function runNew(args: string[]) {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: valtay new <name>");
    process.exit(1);
  }

  const root = findInitRoot(process.cwd());
  if (!root) {
    console.error("No valtay.toml or .valtay/ found — run `valtay init` first.");
    process.exit(1);
  }

  const dir = resolve(root, ".valtay", "runs", name);
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, "runspec.md");

  writeFileSync(outPath, generateRunspec(name), "utf-8");
  console.log(`Created ${outPath}`);
}
