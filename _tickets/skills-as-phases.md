# Skills as phases — portable SKILL.md files

**Status:** built
**Priority:** 1 (dogfooding prerequisite)

## Description

Convert phase prompts from raw `.md` files (loaded via `--append-system-prompt`) to
portable SKILL.md files that any host loads through its own skill mechanism.

`prompts.ts` used to load a plain markdown string and the claude-code adapter injected
it via `--append-system-prompt`. That coupled phase prompts to one host's injection
mechanism. SKILL.md is the format Claude Code, Codex, and OpenCode all understand
natively.

## What changed

- `src/prompts.ts` deleted; `src/skills.ts` now owns every skill Valtay ships —
  `loadSkill()` returns a skill (name + source files), not a prompt string
- `assets/phases/*.md` → `assets/phases/*/SKILL.md`, with `name`, `description` and
  `disable-model-invocation: true` frontmatter
- `valtay init` installs all seven skills into `.claude/skills/`, so a phase is a file
  the host finds rather than text Valtay hands it
- `HostRequest.prompt` → `HostRequest.skill` (`{ name, path }`)
- The claude-code adapter names `/valtay-<phase>` at the head of the stdin payload and
  passes no system prompt at all
- A phase whose skill is missing from the directory the host runs in fails with zero
  attempts, before anything is spawned
- `prompt_sha` now hashes the installed SKILL.md — what the host actually read — and
  the manifest carries the skill name alongside it

## Verified against the binary (claude 2.1.260)

`-p` does **not** auto-invoke a skill on relevance the way an interactive session
does, but it **does** expand a leading `/name` — including when the prompt arrives on
stdin rather than as an argument, which is what the docs left open. With the slash
line the phase returns its artifact in the shape its SKILL.md specifies; the same
payload without it comes back visibly uninstructed.

## Follow-ups this leaves

- **`.claude/skills/` must be committed.** Probe and Build run in a git worktree,
  which carries tracked files only. `valtay init` says so; nothing enforces it beyond
  the phase failing loudly.
- **Valtay's own repo is not initialised.** Installing the six phase skills here would
  check in a second copy of `assets/phases/*/SKILL.md` that can drift from the first.
  `dogfood-self-run.md` should decide how (a symlink is the obvious answer).
- **The codex destination is not guessed.** `HOST_SKILL_ROOTS` in `src/skills.ts` has
  one entry; the codex one lands with the codex adapter.

## Enables

- Second host adapter (`second-host-adapter.md`)
- Running Valtay on itself with the new flow (`dogfood-self-run.md`)

## References

- `src/skills.ts` — the skill manifest, the override, and the installer
- `src/hosts/claude-code.ts` — `skillPayload`, and why the instructions are not argv
- `src/run/invoke.ts` — `phaseSkillIn`, the preflight
- `docs/design.md` §7.4 — a phase is a skill
