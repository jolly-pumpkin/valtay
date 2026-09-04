import { basename } from "path";

/**
 * A parsed run spec: YAML frontmatter plus the Markdown body split into its `##`
 * sections. See `docs/RUNSPEC.md` for the format.
 *
 * Sections are the unit a phase receives, not the file — `## Assumptions to verify`
 * is the *only* thing Research is given, and that blindness is enforced here by the
 * section boundary rather than by asking a prompt nicely (design.md §8.2).
 */
export interface Runspec {
  /** Absolute path the spec was read from. */
  path: string;
  /** Verbatim file contents, hashed into the manifest at `start`. */
  raw: string;
  frontmatter: Record<string, unknown>;
  /** The `# ` title, or the file's basename when it has none. */
  title: string;
  /** Section bodies keyed by lowercased heading text. */
  sections: Map<string, string>;
}

/** The section Research receives, and the only one. */
export const ASSUMPTIONS = "assumptions to verify";

/** Sections a complete spec carries, in the order `docs/RUNSPEC.md` lists them. */
export const BODY_SECTIONS = [
  "intent",
  "tickets",
  "conflicts",
  "gaps",
  ASSUMPTIONS,
  "out of scope",
  "notes",
] as const;

const FENCE = /^\s*(```|~~~)/;

/**
 * Splits `body` on `##` headings, ignoring headings inside fenced code blocks —
 * `## Notes` routinely carries examples, and a fenced `## Intent` in one is text,
 * not a section.
 */
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

/**
 * Splits leading `---`-delimited YAML frontmatter off `raw`.
 *
 * The closing delimiter must be a line of exactly `---`; a spec body may contain
 * horizontal rules, and only the first one that stands alone on its own line closes
 * the block.
 */
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

/** One section's body, or null when the spec has no such heading. */
export function section(spec: Runspec, name: string): string | null {
  return spec.sections.get(name.toLowerCase()) ?? null;
}

/**
 * The blind Research input: the assumptions section alone, with nothing that would
 * let a researcher return evidence *for* a design it has already read.
 */
export function researchInput(spec: Runspec): string {
  const assumptions = section(spec, ASSUMPTIONS);
  if (!assumptions) {
    throw new Error(`${spec.path}: no "## ${ASSUMPTIONS}" section — Research has no input`);
  }
  return assumptions;
}

/** Conflict lines still marked UNRESOLVED. Any of these blocks `valtay start`. */
export function unresolvedConflicts(spec: Runspec): string[] {
  const conflicts = section(spec, "conflicts");
  if (!conflicts) return [];
  return conflicts
    .split(/\n(?=\s*[-*]\s)/)
    .map((entry) => entry.trim())
    .filter((entry) => /^\s*[-*]\s/.test(entry) && /UNRESOLVED/i.test(entry));
}

/** Sections that are missing or still carry a scaffolded `TODO` marker. */
export function incompleteSections(spec: Runspec): string[] {
  return BODY_SECTIONS.filter((name) => {
    const body = spec.sections.get(name);
    return body === undefined || body.length === 0 || /\bTODO\b/.test(body);
  });
}

/** SHA-256 of any content, used for the spec freeze and for approval binding. */
export function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
