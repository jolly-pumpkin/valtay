import type { HostAdapter, HostRequest, HostResult } from "./types.ts";

export interface ReplayResponse {
  output?: string;
  error?: string;
  exit_code?: number;
}

export interface ReplayAdapter extends HostAdapter {
  /** Every request the orchestrator made, in order. */
  calls: HostRequest[];
  /** Responses not yet consumed. */
  remaining(): number;
}

/**
 * A host adapter that replays canned responses instead of calling a model.
 *
 * The orchestrator's own behaviour — gate stops, typed rejection, retry, resume —
 * is control flow, and control flow should be testable without a network call or a
 * bill. Recording the requests also lets a test assert what a phase was *given*,
 * which is how Research blindness stays verified end to end rather than only at the
 * section extractor.
 */
export function createReplayAdapter(
  name: string,
  responses: Array<string | ReplayResponse>
): ReplayAdapter {
  const queue = [...responses];
  const calls: HostRequest[] = [];

  return {
    name,
    calls,
    remaining: () => queue.length,
    async run(request: HostRequest): Promise<HostResult> {
      calls.push(request);

      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`Replay adapter "${name}" ran out of responses on call ${calls.length}`);
      }

      const response = typeof next === "string" ? { output: next } : next;
      return {
        output: response.output ?? "",
        exit_code: response.exit_code ?? (response.error ? 1 : 0),
        duration_s: 0,
        ...(response.error ? { error: response.error } : {}),
      };
    },
  };
}
