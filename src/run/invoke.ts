import { adapterFor } from "../hosts/index.ts";
import type { HostRequest } from "../hosts/types.ts";
import { loadPrompt } from "../prompts.ts";
import { researchInput, sha256, section, type Runspec } from "../runspec.ts";
import { outputPath, phase, type PhaseDef } from "./phases.ts";
import {
  appendManifest,
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

/** A phase's output is unusable — the message is fed back on the retry. */
function validate(def: PhaseDef, output: string): string | null {
  if (output.trim().length === 0) return "the output was empty";

  if (def.leading && !output.startsWith(def.leading)) {
    return `the artifact must begin with "${def.leading}"`;
  }

  if (def.format === "json") {
    try {
      JSON.parse(output);
    } catch (err) {
      return `the output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return null;
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

  const base: HostRequest = {
    binding,
    host,
    prompt,
    input: renderPayload(inputs),
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

    const invalid = result.exit_code === 0 ? validate(def, artifact) : null;
    const failure = result.error ?? invalid;
    const ref = failure ? undefined : await writeArtifact(run, output, `${artifact}\n`);

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
    correction = invalid
      ? `# Correction\n\nYour previous attempt was rejected: ${invalid}. Emit only the artifact.\n`
      : "";
  }

  return { ok: false, error: lastError, attempts: 2 };
}
