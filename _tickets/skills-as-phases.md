# Skills as phases — portable SKILL.md files

**Status:** not started
**Priority:** 1 (dogfooding prerequisite)

## Description

Convert phase prompts from raw `.md` files (loaded via `--append-system-prompt`) to portable SKILL.md files that any host can load through its own skill/instruction mechanism.

Currently `prompts.ts` loads a plain markdown string and the claude-code adapter injects it via `--append-system-prompt`. This couples phase prompts to one host's injection mechanism. SKILL.md is the format Claude Code, Codex, and OpenCode all understand natively.

## What changes

- `prompts.ts` → `loadSkill()` returning a directory path, not a string
- `assets/phases/*.md` → `assets/phases/*/SKILL.md` (same content, SKILL.md shape)
- `HostRequest` passes a skill path instead of a prompt string
- Each adapter loads the skill its own way (claude-code: `--append-system-prompt` from the SKILL.md, codex: its own instruction loading)

## Why now

This is the portability prerequisite. Without it, the codex adapter can't be built without reimplementing prompt injection per-host. It also makes phase prompts host-agnostic, which is what "skills as phases" means — a phase is a skill any host can run.

## Enables

- Second host adapter (`second-host-adapter.md`)
- Running Valtay on itself with the new flow (`dogfood-self-run.md`)

## References

- `src/prompts.ts` — current loading
- `src/skills.ts` — existing SKILL.md pattern (valtay-compose)
- `src/hosts/types.ts` — HostRequest interface
- `src/hosts/claude-code.ts` — current prompt injection
