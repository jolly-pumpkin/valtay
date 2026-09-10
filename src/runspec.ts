import { basename } from "path";

/**
 * A parsed run spec: YAML frontmatter plus the Markdown body split into its `##`
 * sections. The body has three sections: Design, Out of scope, Notes.
 */
export interface Runspec {
  path: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  title: string;
  sections: Map<string, string>;
}

export const BODY_SECTIONS = ["design", "out of scope", "notes"] as const;

const FENCE = /^\s*(```|~~~)/;

function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (heading !== null) sections.set(heading, buffer.join("\n").trim());
  };

  for (const line of body.split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }

    const headingMatch = fence === null ? line.match(/^##\s+(.+?)\s*$/) : null;
    if (headingMatch) {
      flush();
      heading = headingMatch[1]!.toLowerCase();
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { yaml: "", body: raw };

  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return { yaml: "", body: raw };

  return {
    yaml: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

export function parseRunspec(raw: string, path: string): Runspec {
  const { yaml, body } = splitFrontmatter(raw);

  let frontmatter: Record<string, unknown> = {};
  if (yaml.trim()) {
    const parsed = Bun.YAML.parse(yaml);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path}: frontmatter is not a YAML mapping`);
    }
    frontmatter = parsed as Record<string, unknown>;
  }

  const title = body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? basename(path, ".md");

  return { path, raw, frontmatter, title, sections: splitSections(body) };
}

export async function readRunspec(path: string): Promise<Runspec> {
  return parseRunspec(await Bun.file(path).text(), path);
}

export function section(spec: Runspec, name: string): string | null {
  return spec.sections.get(name.toLowerCase()) ?? null;
}

/** The design section — the only required section. */
export function designSection(spec: Runspec): string {
  const design = section(spec, "design");
  if (!design) {
    throw new Error(`${spec.path}: no "## Design" section`);
  }
  return design;
}

export function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
