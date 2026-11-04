This file provides guidance to Claude Code and other agents when working with code in this repository.

## Project overview

Flow Linear is an Obsidian plugin that adds chosen Linear tickets to the Focus
list of the Flow plugin (github.com/tavva/flow) and keeps a Linear label in step
with them. It works only through Flow's public Focus API.

Design: `docs/plans/2026-11-04-flow-linear-design.md`.

## Rules

- Follow Obsidian's developer policies, submission requirements and plugin
  guidelines; the design's "Guidelines compliance" section lists what applies.
- API keys live in Obsidian SecretStorage, never in `data.json`. Keep
  `docs/secrets.md` up to date.
- All network calls go through `requestUrl`, only to `api.linear.app`.
- All source files start with two `ABOUTME:` comment lines.
- British English in docs and comments; UI text in sentence case.

## Commands

```bash
npm run dev           # Build and watch
npm run build         # Type check and production build (the scanner reruns this)
npm run lint          # Type check and ESLint, fails on warnings
npm run format        # Prettier; format:check in CI
npm test              # Jest
npm run test:coverage # Jest with the 80% threshold (CI runs this)
npm run release       # Production release workflow
```

## Layout

- `src/main.ts`: plugin entry; finds Flow's API, follows `flow:api-ready` and
  `flow:api-unloaded`, debounces Focus changes into syncs, runs the check interval.
- `src/flow-api.ts`: the copy of Flow's `FlowApi` types that Flow Linear uses.
- `src/linear-client.ts`: GraphQL over `requestUrl`, with error kinds.
- `src/sync-decisions.ts`: the pure `decideSyncActions`; every sync rule lives here.
- `src/sync-runner.ts`: fetches state, carries out actions, one run at a time,
  confirms label removals on a later pass.
- `src/add-ticket.ts`, `src/workspace-form.ts`: logic behind the two modals.
- `tests/`: Jest tests; `tests/helpers` has an in-memory Focus list implementing
  `FlowApi` and an in-memory Linear workspace; `tests/fixtures` has recorded
  Linear responses for the client tests.

Flow reports Flow Linear's own writes back as change events, and coalesces
changes, so a sync must be safe to run at any time and do nothing when nothing
has changed. Treat `removed` events and missing items as hints: the label comes
off only when a pass at least `REMOVAL_CONFIRM_DELAY_MS` after the first still
finds no unfinished item.

## Releasing

Releases need Ben's approval at each step:

1. Draft release notes covering every user-facing commit since the last tag
   (`git log <last tag>..HEAD`), not just the current session's work.
2. Ben approves or edits the notes.
3. Propose a version number.
4. Ben approves the version.
5. Run `npm run release -- --version <version> --notes-file <notes>`, wait for the
   release workflow to attach attested assets, then publish the draft.

Never get round the script's prompts in any other way. See `docs/RELEASING.md`.
