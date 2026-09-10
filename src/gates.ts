/**
 * Gate modes for the MVP pipeline.
 *
 * The only gate is `verify`. It auto-passes when the verify artifact says
 * "clean" and stops the run when it says "drift".
 */
export type GateMode = "auto" | "drift";
