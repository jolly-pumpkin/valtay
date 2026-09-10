import { readRunspec, section, BODY_SECTIONS, type Runspec } from "../runspec.ts";

export interface CheckOptions {
  spec: string;
}

export type FindingLevel = "warn" | "info";

export interface Finding {
  level: FindingLevel;
  rule: string;
  message: string;
}

export function checkRunspec(spec: Runspec): Finding[] {
  const findings: Finding[] = [];

  if (!section(spec, "design")) {
    findings.push({
      level: "warn",
      rule: "missing-design",
      message: '"## Design" section is missing',
    });
  }

  for (const name of BODY_SECTIONS) {
    const body = spec.sections.get(name);
    if (body !== undefined && /\bTODO\b/.test(body)) {
      findings.push({
        level: "info",
        rule: "has-todo",
        message: `"## ${name}" still carries a TODO`,
      });
    }
  }

  return findings;
}

export function formatFindings(spec: Runspec, findings: Finding[]): string[] {
  const header = [`Check "${spec.title}"`, `  spec    ${spec.path}`];

  if (findings.length === 0) {
    return [...header, "", "  no findings"];
  }

  const lines = findings.map((f) => `  ${f.level.padEnd(4)}    [${f.rule}] ${f.message}`);
  return [...header, "", ...lines];
}

export async function runCheck(options: CheckOptions): Promise<string[]> {
  const spec = await readRunspec(options.spec);
  return formatFindings(spec, checkRunspec(spec));
}
