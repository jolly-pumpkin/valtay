import { relative } from "path";

/**
 * Arg summary for a tool_use block. Returns the file path, command, or pattern
 * depending on the tool name, or an empty string for unknown tools.
 */
function argSummary(name: string, input: Record<string, unknown>): string {
  const cwd = process.cwd();

  const relativize = (p: string): string =>
    typeof p === "string" && p.startsWith(cwd) ? relative(cwd, p) : p;

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return typeof input.file_path === "string" ? relativize(input.file_path) : "";
    case "NotebookEdit":
      return typeof input.notebook_path === "string" ? relativize(input.notebook_path) : "";
    case "Bash": {
      if (typeof input.command !== "string") return "";
      const cmd = input.command.replace(/\n/g, " ");
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Grep":
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : "";
    default:
      return "";
  }
}

/**
 * Format a single stream-json line into a terminal-friendly string.
 * Returns null for non-tool-use events.
 */
export function formatEvent(line: string, label: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj.type !== "assistant") return null;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return null;

  const lines: string[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = block.name as string;
    const input = (block.input as Record<string, unknown>) ?? {};
    const summary = argSummary(name, input);
    const suffix = summary ? ` ${summary}` : "";
    lines.push(`  [${label}] ${name}${suffix}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
