/** Check whether filePath is allowed by the manifest.
 *
 *  The manifest contains one path per line:
 *  - Repo-relative paths (e.g. "src/foo.ts") for worktree files
 *  - Absolute paths (e.g. "/abs/path/reports/RU-1.md") for out-of-worktree files
 *
 *  filePath from the hook event is always absolute. The function checks:
 *  1. Exact match against the raw absolute path (catches report writes).
 *  2. Normalize to repo-relative (strip projectDir prefix), then exact match.
 */
export async function filesetAllows(
  manifestPath: string,
  filePath: string,
  projectDir?: string,
): Promise<boolean> {
  const raw = await Bun.file(manifestPath).text();
  const entries = new Set(
    raw.split("\n").map((l) => l.trim()).filter(Boolean),
  );

  // 1. Exact match against the raw absolute path
  if (entries.has(filePath)) return true;

  // 2. Normalize to repo-relative, then exact match
  if (projectDir) {
    const prefix = projectDir.endsWith("/") ? projectDir : projectDir + "/";
    if (filePath.startsWith(prefix)) {
      const relative = filePath.slice(prefix.length);
      if (entries.has(relative)) return true;
    }
  }

  return false;
}
