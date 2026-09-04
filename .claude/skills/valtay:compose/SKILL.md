---
name: valtay-compose
description: >-
  Draft, complete, and pressure-test a Valtay run spec (runspec.md) — the single
  human-authored input to a valtay run. Use when writing or filling out a run spec,
  reconciling a PRD, tech design, and tickets against each other, framing assumptions
  for the blind Research phase, or getting a spec ready to start a run.
---

# Composing a Valtay run spec

A run spec is one Markdown file — YAML frontmatter plus seven body sections — and it
is the **entire input** to a Valtay run. There is no intake phase. Whatever is in this
file is what the run gets.

Your job in this skill is to help the user turn a scaffold full of `TODO` markers into
a spec that is complete, internally consistent, and honest about what it does not
cover.

## The one rule

**Valtay reads a file, never a conversation.** Nothing you and the user work out
together matters unless it lands in the file. A decision reached in chat and not
written down is a decision the run will not see.

The corollary: this session is a text editor with opinions. Be opinionated — argue
about scope, push back on a vague intent, insist a conflict get resolved — but the
deliverable is always the edited file.

## Workflow

1. **Find or scaffold the spec.** Look for a `runspec.md` in the repo or under
   `.valtay/runs/<repo>/<run>/`. If there is none, scaffold one:

   ```bash
   valtay new <run-name> --repo . --tickets LIN-483,LIN-484
   ```

   That is pure scaffolding — no model call. It pre-fills what is derivable (run name,
   repo, date, ticket stubs, defaults from `valtay.toml`) and leaves `TODO` markers on
   everything else.

2. **Read every source before writing anything.** The frontmatter's `sources:` block
   points at a PRD, a tech design, an epic, and tickets. Read all of them. Most of the
   value you add is in the *contradictions between* these documents, and you cannot
   see those without holding all of them at once.

3. **Fill the body sections in order.** Intent first — it is the scope authority, and
   every later section is easier once it is settled.

4. **Run the completeness checklist** (below) before telling the user the spec is
   done. Report what you found rather than silently fixing it; dispositions are the
   user's call.

## Section-by-section

Read `reference/format.md` for the full frontmatter schema and the section contract.
These are the rules that are easy to get wrong:

**`## Intent`** — one paragraph on what should be true when the run ships. This is the
**scope authority**: it outranks the tickets and the PRD. If the tickets imply more
than the intent, the intent wins and the excess belongs in `## Out of scope`. Do not
write *how* — that is the design's job.

**`## Tickets`** — bold ID, dash, one-line summary. These are **advisory**. The plan
may merge, split, reorder, or defer them, so do not smuggle structural intent into the
ticket list and expect it to survive.

**`## Conflicts`** — genuine contradictions *between* source documents, each with an ID
and a resolution arrow. **Unresolved conflicts block the start of a run**, so drive
every one to a decision or move it into `## Out of scope`. A resolution should say why,
not just which:

```markdown
- **C-1** LIN-484 puts health on `Player`; tech design §2 puts it on `RunState`.
  → **RESOLVED: Player.** RunState is serialized to save files and adding a field
  breaks save compatibility.
```

Do not invent conflicts to look thorough, and do not record a conflict the user has
already settled in the same breath — write the resolution.

**`## Gaps`** — coverage holes, each with an ID and a **disposition**: in-scope (the
design phase handles it) or out-of-scope (acknowledged and excluded). A gap with no
disposition is an unfinished thought, not a gap. Ask the user to disposition it.

**`## Assumptions to verify`** — **the only section the Research phase receives.**
Research sees no intent, no tickets, no design. Two consequences:

- Each assumption must **stand alone**. A bullet that only parses next to the intent or
  the design is useless to a blind reader. Inline the context it needs.
- Frame each as something to **verify**, never as a finding. The value of the run is
  the gap between what was assumed and what the code actually does — a bullet phrased
  as a claim pre-loads the answer and destroys that gap.

```markdown
- **A-1** Tech design §4.2 assumes `sim` emits events. Verify: it may mutate
  `RunState` directly.
- **A-2** Assumes enemies are removed on leak. Verify: they may be marked, not removed.
```

Resist the urge to be helpful by adding what you know about the code here. If you
already know the answer, the assumption does not belong in the list.

**`## Out of scope`** — explicit exclusions. This is a fence: it stops a helpful agent
from pulling adjacent work into the run. Anything the user said "not now" about goes
here, in writing.

**`## Notes`** — free-form hints for the pipeline. Delete the section if empty rather
than leaving a `TODO`.

## Completeness checklist

Run all five before calling the spec done:

1. **Every pair of source documents diffed.** For each pair (PRD × design, design ×
   tickets, PRD × tickets), did you actually look for contradictions? Each one found
   is a `C-` entry with a resolution.
2. **Every ticket checked for design coverage.** A ticket with no corresponding design
   section is a `G-` entry, dispositioned.
3. **Every assumption phrased as a question, and self-contained.** Re-read the
   assumptions section *as if it were the whole file*. Anything that reads as a finding,
   or that dangles without context, gets rewritten.
4. **Out-of-scope stated, not implied.** Scan the intent for the word "just" or "only"
   — whatever it is excluding should be named explicitly in `## Out of scope`.
5. **No `TODO` markers left**, in frontmatter or body. A leftover `TODO` in the
   frontmatter is a config the run will take literally.

## Failure modes

- **An assumption written as a claim.** "The sim emits events" instead of "Verify
  whether the sim emits events." The single most common way to waste a run.
- **Design detail leaking into `## Assumptions to verify`.** Research is blind on
  purpose. Describing the proposed design in an assumption makes the researcher return
  evidence *for* that design, which is exactly the outcome the blindness prevents.
- **A conflict left `UNRESOLVED`.** It blocks the run. Surface it to the user as a
  decision they need to make now, not a note for later.
- **A gap with no disposition.** Reads as thorough, changes nothing.
- **Padding.** Six invented conflicts are worse than one real one. Volume is not rigor.

## Reference files

- **`reference/format.md`** — full frontmatter schema and the section contract table
  (which phase consumes which section). Read it when filling frontmatter or when you
  need to know who sees what.
- **`reference/example.md`** — a complete, filled-in run spec. Read it when the user
  asks what "done" looks like, or when you want a model for tone and density.
