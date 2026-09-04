import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import type { HostAdapter } from "./types.ts";

export type { HostAdapter, HostRequest, HostResult, PhaseSkill } from "./types.ts";
export { stripFence } from "./types.ts";
export { claudeCodeAdapter, claudeArgs, skillPayload } from "./claude-code.ts";
export { codexAdapter, codexArgs, codexPayload, parseCodexStream } from "./codex.ts";

const ADAPTERS = new Map<string, HostAdapter>([
  [claudeCodeAdapter.name, claudeCodeAdapter],
  [codexAdapter.name, codexAdapter],
]);

/**
 * Registers an adapter, replacing any of the same name. Returns a function that
 * restores what was there before, so a test can install a replay adapter without
 * leaking it into the next one.
 */
export function registerAdapter(adapter: HostAdapter): () => void {
  const previous = ADAPTERS.get(adapter.name);
  ADAPTERS.set(adapter.name, adapter);

  return () => {
    if (previous) ADAPTERS.set(adapter.name, previous);
    else ADAPTERS.delete(adapter.name);
  };
}

export function adapterFor(name: string): HostAdapter {
  const adapter = ADAPTERS.get(name);
  if (!adapter) {
    throw new Error(`No adapter "${name}". Available: ${[...ADAPTERS.keys()].join(", ")}`);
  }
  return adapter;
}
