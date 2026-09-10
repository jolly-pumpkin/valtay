---
name: valtay-compose
description: >-
  Draft, complete, and pressure-test a Valtay run spec (runspec.md) — the single
  human-authored input to a valtay run. Use when writing or filling out a run spec,
  designing structures and interfaces, or getting a spec ready to start a run.
---

# Composing a Valtay run spec

A run spec is one Markdown file — YAML frontmatter plus three body sections — and
it is the **entire input** to a Valtay run. The human writes the design. The AI
plans, builds, and verifies from it.

Your job in this skill is to help the user turn a scaffold full of `TODO` markers
into a spec that is complete, concrete, and honest about what it does not cover.

## The one rule

**Valtay reads a file, never a conversation.** Nothing you and the user work out
together matters unless it lands in the file. A decision reached in chat and not
written down is a decision the run will not see.

## Workflow

1. **Find or scaffold the spec.** Look for a `runspec.md` in the repo or under
   `.valtay/runs/<name>/`. If there is none, scaffold one:

   ```bash
   valtay new <run-name>
   ```

2. **Fill the body sections in order.** Design first — it is the source of truth
   for everything downstream.

3. **Run the completeness checklist** (below) before telling the user the spec is
   done.

## Section-by-section

Read `reference/format.md` for the full frontmatter schema and the section contract.

**`## Design`** — structures, interfaces, and intent. This is where the human's
design lives. Be concrete:

- **Types and interfaces** as actual code declarations, not prose descriptions
- **Function signatures** showing what changes, in the project's language
- **Intent** in one paragraph — what should be true when the run ships

The design is the source of truth. The plan phase reads it to cut the work. The
build phase reads it to implement. The verify phase reads it to check for drift.

A paragraph where a type declaration would do is the failure mode here. Code is
better than prose for structures and interfaces.

**`## Out of scope`** — explicit exclusions. This is a fence: it stops the builder
from pulling adjacent work into the run. Anything the user said "not now" about
goes here, in writing.

**`## Notes`** — free-form hints for the pipeline. Delete the section if empty
rather than leaving a `TODO`.

## Completeness checklist

Run all three before calling the spec done:

1. **Design is concrete.** Types and function signatures, not paragraphs. Read the
   design section — could a builder implement it without guessing? If not, make it
   more specific.
2. **Out-of-scope stated, not implied.** Scan the design for implied boundaries
   ("just", "only", "for now") — whatever is being excluded should be named
   explicitly in `## Out of scope`.
3. **No `TODO` markers left**, in frontmatter or body.

## Failure modes

- **A design written as prose instead of code.** "The player should have health"
  instead of `interface Player { health: number; max_health: number }`. The
  builder will guess the shape, and the verify phase will catch the drift — but
  the human could have prevented it by being specific.
- **Padding.** An out-of-scope list with six items the builder would never have
  thought of is worse than three real exclusions.

## Reference files

- **`reference/format.md`** — full frontmatter schema and section contract table
- **`reference/example.md`** — a complete, filled-in run spec
