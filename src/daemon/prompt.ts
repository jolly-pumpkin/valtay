/**
 * Build the initial prompt sent to Claude Code inside the daemon's tmux session.
 * Pure function — no I/O.
 */
export function buildPrompt(runName: string, runspecPath: string): string {
  return [
    `You are running the Valtay pipeline for run "${runName}".`,
    `The runspec is at: ${runspecPath}`,
    "",
    "Execute the following phases in order, waiting for each to complete before starting the next:",
    "",
    "1. Run /valtay-plan",
    "2. After plan.md is written, run: valtay advance --run " + runName,
    "3. Run /valtay-build",
    "4. After build.md is written, run: valtay advance --run " + runName,
    "5. Run /valtay-verify",
    "6. After verify.json is written, run: valtay advance --run " + runName,
    "",
    "After the final advance:",
    "- If verify is clean (run completes), exit with code 0.",
    "- If verify finds drift, print the findings to stdout and exit with code 1.",
  ].join("\n");
}
