import { adapterFor } from "../hosts/index.ts";
import type { HostRequest } from "../hosts/types.ts";
import { loadPrompt } from "../prompts.ts";
import { researchInput, sha256, section, type Runspec } from "../runspec.ts";
import { validatePlan } from "../plan.ts";
import { outputPath, phase, phaseForArtifact, type PhaseDef } from "./phases.ts";
import {
  appendManifest,
  readApprovals,
  readArtifact,
  writeArtifact,
  type ArtifactRef,
  type ManifestRecord,
  type Run,
} from "./store.ts";

export interface PhaseInput {
  /** Heading the payload block carries, so the phase can tell its inputs apart. */
  label: string;
  content: string;
  /** Set when the input is a run artifact, for the manifest's `inputs`. */
  ref?: ArtifactRef;
}

export interface PhaseOutcome {
  ok: boolean;
  output?: ArtifactRef;
  error?: string;
  attempts: number;
}

/** Reads one of the run's artifacts as a phase input, hashed for the manifest. */
async function artifactInput(run: Run, path: string, label: string): Promise<PhaseInput> {
  const content = await readArtifact(run, path);
  if (content === null) throw new Error(`Missing input ${path} — run the phase that produces it first`);
  return { label, content, ref: { path, sha: sha256(content) } };
}

function specInput(spec: Runspec, name: string, label: string): PhaseInput[] {
  const content = section(spec, name);
  return content ? [{ label, content }] : [];
}

/**
 * What each phase is given.
 *
 * This function is where design.md §8's input column is enforced. Research's case is
 * load-bearing: it returns the assumptions section alone, and no branch of this
 * function can add to it.
 */
export async function inputsFor(run: Run, spec: Runspec, def: PhaseDef): Promise<PhaseInput[]> {
  const repo = run.meta.repo;
  const design = () => artifactInput(run, "design.md", "The approved design delta");
  const shape = () => artifactInput(run, outputPath(phase("shape"), repo), "The approved shape");

  switch (def.id) {
    case "research":
      return [{ label: "Assumptions to verify", content: researchInput(spec) }];

    case "reconcile":
      return [
        ...specInput(spec, "intent", "Intent"),
        ...specInput(spec, "tickets", "Tickets"),
        ...specInput(spec, "gaps", "Gaps"),
        ...specInput(spec, "out of scope", "Out of scope"),
        await artifactInput(run, "research.md", "Research findings"),
      ];

    case "shape":
      return [...specInput(spec, "intent", "Intent"), await design()];

    case "plan":
      return [await design(), await shape(), ...specInput(spec, "out of scope", "Out of scope")];

    case "probe":
      return [await artifactInput(run, "plan.json", "The approved plan"), await shape()];

    case "build":
      return [
        await artifactInput(run, "plan.json", "The approved plan"),
        await shape(),
        await artifactInput(run, "probe.md", "What the probe discovered"),
      ];
  }
}

export function renderPayload(inputs: PhaseInput[]): string {
  return inputs.map((input) => `# ${input.label}\n\n${input.content.trim()}\n`).join("\n");
}

/**
 * Drops anything a phase emitted ahead of its artifact's opening heading.
 *
 * Exported for its test: this is the mechanical half of the `leading` rule, and the
 * validator below is the half that fails a phase whose heading is missing entirely.
 */
export function trimPreamble(output: string, leading?: string): string {
  if (!leading) return output;

  const index = output.indexOf(`\n${leading}`);
  return index === -1 ? output : output.slice(index + 1);
}

export interface Validation {
  /** Why the artifact is unusable. Fed back to the phase on the retry. */
  error?: string;
  /** The artifact as it should be stored, when validation normalized it. */
  normalized?: string;
}

/**
 * Checks a phase's output, and normalizes it where the stored form should differ
 * from what the host emitted.
 *
 * JSON artifacts are re-serialized indented. A model emits `plan.json` on one line,
 * and a one-line plan is unreadable at G3 — which design.md §12.1 requires be
 * answerable from a phone. Reformatting on the way in is cheaper than asking the
 * planner to indent and more reliable than hoping it does.
 */
function validate(run: Run, def: PhaseDef, output: string): Validation {
  if (output.trim().length === 0) return { error: "the output was empty" };

  if (def.leading && !output.startsWith(def.leading)) {
    return { error: `the artifact must begin with "${def.leading}"` };
  }

  if (def.format !== "json") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    return { error: `the output is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (def.id === "plan") {
    const problems = validatePlan(parsed, run.meta.config);
    if (problems.length > 0) return { error: problems.join("; ") };
  }

  return { normalized: JSON.stringify(parsed, null, 2) };
}

/**
 * The reviewer's own words, when this phase is being re-entered because they
 * rejected its output.
 *
 * A rejection re-runs the phase with the correction appended — not the whole
 * conversation, just what was wrong. Only the most recent one is carried: an older
 * rejection of an artifact that has since been rewritten is stale advice.
 */
async function reviewerCorrection(run: Run, def: PhaseDef): Promise<string> {
  const rejection = (await readApprovals(run))
    .filter((a) => a.decision === "reject" && a.to && phaseForArtifact(a.to, run.meta.repo)?.id === def.id)
    .at(-1);

  if (!rejection?.reason) return "";
  return `# Correction from your reviewer\n\nThey rejected the previous ${outputPath(def, run.meta.repo)}:\n\n${rejection.reason}\n`;
}

/**
 * Runs one phase, with design.md §18's retry policy.
 *
 * A transport failure retries once on the same binding. A schema-invalid output
 * retries once with the validation error appended, because a model told exactly what
 * was wrong usually fixes it and a second blind attempt usually does not. Every
 * attempt is written to the manifest, failures included (invariant 7).
 */
export async function runPhase(run: Run, spec: Runspec, def: PhaseDef): Promise<PhaseOutcome> {
  const binding = run.meta.config.roles[def.role];
  const host = run.meta.config.hosts[binding.host];
  if (!host) throw new Error(`Role ${def.role} is bound to unknown host ${binding.host}`);

  const prompt = await loadPrompt(def.id);
  const inputs = await inputsFor(run, spec, def);
  const output = outputPath(def, run.meta.repo);

  const payload = renderPayload(inputs) + (await reviewerCorrection(run, def));

  const base: HostRequest = {
    binding,
    host,
    prompt,
    input: payload,
    workdir: run.meta.repo,
    readDirs: [run.dir],
    write: def.write,
    timeout_ms: binding.timeout_ms,
  };

  let correction = "";
  let lastError = "unknown failure";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const request = correction ? { ...base, input: `${base.input}\n${correction}` } : base;
    const result = await adapterFor(host.adapter).run(request);
    const artifact = trimPreamble(result.output.trim(), def.leading);

    const checked = result.exit_code === 0 ? validate(run, def, artifact) : {};
    const failure = result.error ?? checked.error;
    const ref = failure
      ? undefined
      : await writeArtifact(run, output, `${checked.normalized ?? artifact}\n`);

    const record: ManifestRecord = {
      ts: new Date().toISOString(),
      phase: def.id,
      role: def.role,
      host: binding.host,
      model: binding.model,
      ...(binding.effort ? { effort: binding.effort } : {}),
      prompt_sha: sha256(prompt),
      inputs: inputs.flatMap((i) => (i.ref ? [i.ref] : [])),
      outputs: ref ? [ref] : [],
      duration_s: Math.round(result.duration_s * 10) / 10,
      exit_code: result.exit_code,
      attempt,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.cost_usd === undefined ? {} : { cost_usd: result.cost_usd }),
      ...(result.permission_denials ? { permission_denials: result.permission_denials } : {}),
      notes: failure ? [failure] : [],
    };
    await appendManifest(run, record);

    if (!failure) return { ok: true, output: ref, attempts: attempt };

    lastError = failure;
    correction = checked.error
      ? `# Correction\n\nYour previous attempt was rejected: ${checked.error}. Emit only the artifact.\n`
      : "";
  }

  return { ok: false, error: lastError, attempts: 2 };
}
