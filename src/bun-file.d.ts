/** Bun's `with { type: "file" }` import attribute returns the resolved file path as a string. */
declare module "*.md" {
  const path: string;
  export default path;
}
