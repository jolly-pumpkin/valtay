import { filesetAllows } from "./fileset-allows.ts";

const event = await Bun.stdin.json();
const filePath = event.tool_input.file_path ?? event.tool_input.notebook_path;

if (!filePath) {
  // Unknown tool shape — fail safe
  console.error("fileset hook: no file_path or notebook_path in tool_input");
  process.exit(2);
}

const manifest = process.env.VALTAY_FILESET;
if (!manifest) {
  console.error("fileset hook: VALTAY_FILESET not set");
  process.exit(2);
}

if (!(await filesetAllows(manifest, filePath, process.env.CLAUDE_PROJECT_DIR))) {
  // Log denial to denials.log
  const filesetDir = manifest.replace(/\/filesets\/[^/]+$/, "");
  const denialsPath = `${filesetDir}/hooks/denials.log`;
  const unitId = manifest.match(/\/filesets\/([^/]+)\.txt$/)?.[1] ?? "unknown";
  const line = `${new Date().toISOString()}\t${unitId}\t${filePath}\n`;
  await Bun.write(denialsPath, line, { append: true });

  console.error(
    `file outside declared set: ${filePath} — report the layer blocked instead of writing around the fence`
  );
  process.exit(2);
}
