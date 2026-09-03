/**
 * Markdown shipped as an asset rather than imported as code.
 *
 * With Bun's `import x from "./f.md" with { type: "file" }`, the default export is
 * the path to the file on disk — a real path when running from source, an embedded
 * one under `bun build --compile`. Read it with `Bun.file()`.
 */
declare module "*.md" {
  const path: string;
  export default path;
}
