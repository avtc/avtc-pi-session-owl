## Text Review

**Protected text** = prompt/skill/agent markdown (files under `agents/`, `skills/`, `.pi/`) + user-facing strings in extension code and documents (`notify()`, dialogs, status messages, errors).

**Rule:** Any add/modify/remove of protected text → present exact before/after to user → wait for approval → apply.

### Approved Text

Protected text in design doc must be:
1. Presented to user for approval before writing to the doc.
2. Marked `<!-- approved -->` adjacent to the approved text. Markers needed only in -design docs. No need to add them to source code or prompts.

Once approved, text can be applied directly during implementation. Any subsequent change to approved text (from review, revalidation, etc.) must be re-presented to user before applying.

## Conventions

- `npm test` runs the full build/lint/test suite.
- use `npx vitest run` to run specific tests.
- Update tests and documentation when behavior changes.
- Follow existing prompts and code style.
- **Source comments and product docs (README, CONFIGURATION) stay free of design-doc references and historical framing** — no §N, D27, R2-8, "Design ref", "has moved to"/"formerly"/"is now"/"no longer", or "(module.ts)" breadcrumbs. Design-doc and plan-section references belong in design docs and the `.featyard/` artifact docs (plans, research, reviews) that trace to them.