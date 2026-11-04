# Flow Linear design

## Overview

Flow Linear is an Obsidian plugin that puts chosen Linear tickets into Flow's
Focus list and completes them there when they're done in Linear.

1. Run "Add Linear ticket to Focus", paste a ticket URL, keep the ticket's
   title or write your own wording, and pick a sphere.
2. Every few minutes the plugin reads the state of the tickets behind
   unfinished Focus items, and completes the items of tickets that are done,
   cancelled or deleted.

Flow Linear only reads from Linear. It doesn't use a Linear label or change
anything in Linear. (An earlier version of this design kept a shared
workspace label in step with Focus; it was dropped because one workspace
label collides between people and between vaults.)

Flow knows nothing about Linear. Flow Linear works only through Flow's Focus
API, designed in Flow's `docs/plans/2026-11-04-focus-api-design.md`. Names
here match that design.

Out of scope: Linear tickets anywhere in Flow other than Focus, adding
tickets from Linear's side (see "For later"), creating or editing tickets,
closing tickets from Flow, sources other than Linear.

## Terms

- **Workspace**: a Linear workspace (Linear calls it an organisation), with
  its own API key. Ben uses several.
- **Linked item**: an external Focus item with `sourceName: "linear"` whose
  `url` points at a ticket. The URL carries the workspace's `urlKey` and the
  ticket's identifier, so the Focus item is the only record of the link.
- **Unfinished**: a linked item without `completedAt`.

## Settings

The settings tab is declarative (`getSettingDefinitions()`, Obsidian 1.13), so
`minAppVersion` is `1.13.0`.

- **Old Flow warning**: a row at the top, shown until dismissed, saying that
  Flow 1.3.12 or earlier on any device that syncs the vault will delete the
  Linear items from Focus, and that the deletion syncs to every device. The
  README says the same in its setup section.
- **Workspaces**: a `type: 'list'` setting. Adding one opens a form modal:
  - _Linear API key_: one password field, placeholder `lin_api_…`. Obsidian's
    `SecretComponent` picker asks for a secret "ID" and shows an `sk-…`
    example, which confused setup, so the plugin names the secret itself.
    The README asks for a key with Read permission only, which Linear's
    personal API keys allow (optionally limited to chosen teams).
  - On save the plugin queries `viewer { organization { name urlKey } }` with
    the key. That checks the key works and fills in the workspace's `urlKey`,
    so you never type the slug. It then stores the key with
    `app.secretStorage.setSecret("flow-linear-<urlKey>", key)` (the `urlKey`
    reduced to the lower-case letters, digits and dashes secret names allow)
    and records that name as `apiKeySecretName`. Settings never hold the key.
  - _Display name_: defaults to the organisation's name. Used as the Focus
    item's `sourceLabel` (the chip in Focus and the heading on the TV board).
  - _Default sphere_: a dropdown of Flow's spheres (`getSpheres()`).
  - Each row shows its display name and `urlKey`, and a "Change key" button
    that opens the same password field, checks the new key belongs to the
    same workspace, and stores it under the workspace's secret name. It's
    also how a key is entered on another device, where the workspace arrives
    through synced settings without one.
  - Rows can be deleted. SecretStorage has no delete, so deleting a workspace
    overwrites its secret with an empty value, which reads as no key.
- **Check every**: minutes between checks, default 5, minimum 1.
- **Status**: a read-only row per workspace with the last successful check
  time or the last error.

Stored in `data.json`:

```typescript
interface FlowLinearSettings {
  workspaces: WorkspaceSettings[];
  checkIntervalMinutes: number; // Default 5
  oldFlowWarningDismissed: boolean;
}

interface WorkspaceSettings {
  urlKey: string; // From the API, e.g. "acme"
  displayName: string; // e.g. "Acme"
  apiKeySecretName: string; // Name in Obsidian's SecretStorage
  defaultSphere: string;
}
```

Nothing else is stored. When `data.json` changes on disk (another device's
settings arriving through sync), the plugin reloads it.

## Adding a ticket from a URL

Command: "Add Linear ticket to Focus" (id `add-ticket-to-focus`, no default
hotkey).

1. A modal asks for the URL. Accepted form:
   `https://linear.app/<urlKey>/issue/<IDENTIFIER>[/<title-slug>]`, with or
   without query string or fragment.
2. `urlKey` picks the workspace. If none matches, the modal says which
   workspaces are set up and adds nothing.
3. The plugin checks the key with `viewer { organization { urlKey } }`. If it
   belongs to a different workspace, the modal says so and adds nothing.
4. It fetches the ticket with `issue(id: "<IDENTIFIER>")`. Linear accepts the
   identifier there, including one the ticket had before it moved team. "Not
   found" may mean there's no such ticket or that the key can't see it; the
   modal says both.
5. If the ticket's state type is `completed` or `canceled`, or the link
   Linear returns names another workspace, the modal says so and adds nothing.
6. The modal shows the title in an editable wording field and the sphere
   (default from the workspace) in a dropdown. Add saves; Escape cancels.
7. On Add: `api.addFocusItem({ text, sphere, sourceName: "linear",
sourceLabel: displayName, url: canonicalUrl, externalId: identifier })`.

Pasting a ticket that already has linked items adds another step for it. It
doesn't replace the existing ones. While a lookup or an add is waiting, a
second Enter or click is ignored, and nothing is drawn into a modal that has
been closed.

## Completing items

### When it runs

- 30 seconds after Flow's API becomes available (see "Finding Flow"), to give
  the vault's sync time to bring in other devices' changes. Nothing runs
  before then.
- Once `checkIntervalMinutes` have passed since the last check. One timer,
  registered once with `registerInterval(window.setInterval(…))`, ticks every
  minute and checks when the interval is up, so a check comes within a minute
  of it and changing the interval needs no new timer.
- After a workspace is added, and after settings reload from disk (which also
  redraws an open settings tab).

Only one check runs at a time. A request made during a check, including one
made as the check finishes, queues a single follow-up.

### What it does

Per workspace with a key on this device:

1. Read the Focus items with `getFocusItems("linear")` and keep the
   unfinished ones whose URL names this workspace, grouped by identifier.
2. If there are none, ask Linear nothing.
3. Check the key with `viewer { organization { urlKey } }`. `data.json` names
   only the secret, so another device's secret of that name may hold a key
   for a different workspace. If the `urlKey` doesn't match, set a status
   error, show one notice, and skip the workspace.
4. Fetch the tickets' states, 50 at a time, with `issues(filter: { or: [{
   team: { key }, number }] }, includeArchived: true)`. An identifier that
   doesn't come back that way (the ticket may have moved team) is looked up
   on its own with `issue(id:)`.
5. For each ticket whose state type is `completed` or `canceled`, or which is
   trashed, call `completeFocusItem` on each of its unfinished items. A
   trashed ticket is logged with `console.warn` once its item is completed.
   Linear keeps deleted tickets in the trash, with `trashed: true`, for about
   30 days, so a check in that time catches them.
6. A ticket Linear doesn't return is never completed: "not found" may only
   mean the key can't see it (a wrong key, a key limited to other teams, or a
   private team the user has left). Those identifiers go in the status row
   ("2 tickets not visible with this key: ABC-12, ABC-40") and in one notice
   per session.
7. An open ticket whose identifier has changed (it moved, or its team key was
   renamed) gets its items relinked with `updateFocusItem(id, { url,
   externalId })`, so later checks look it up by its current identifier, the
   chip shows it, and a team key reused later can't match a different ticket.
   Flow builds from before `externalId` could be changed ignore that field and
   update only the link, which is what checks read. The first lookup of a
   moved ticket still goes by its old team key and number, so a team key
   reused before that lookup could match a different ticket; that's accepted
   rather than storing ticket UUIDs.

A pure function, `planCompletionCheck(itemsByIdentifier, tickets)`, decides
what to complete and relink and what isn't visible; the `CompletionChecker`
does the reading and writing, and stops between items if Flow unloads.

Completing is idempotent (`completeFocusItem` keeps the first completion
time), so the check needs no stored state, no confirmation and no
coordination between devices or vaults. Flow reports the plugin's own writes
back as change events; the plugin doesn't listen to them.

An item whose completion fails because it has already gone or been completed
counts as done. Other failures are reported after the remaining items have
been tried.

## Finding Flow

As set out in the Focus API design:

- In `onLayoutReady`, look up `app.plugins.getPlugin("flow")?.api`.
  `app.plugins` isn't in Obsidian's public typings, so `src/flow-api.ts`
  declares the narrow type used, with a copy of Flow's `FlowApi` interface.
- If Flow is enabled but has no `api` with an `apiVersion` (Flow 1.3.12 and
  earlier), show a notice that stays until clicked and don't run. This only
  protects this device, so the settings warning is still needed.
- Listen for `flow:api-ready` and `flow:api-unloaded` workspace events to cope
  with Flow being enabled, disabled or reloaded later. After unload Flow's API
  refuses writes, so the plugin drops it and finds it again on ready. A check
  interrupted by the unload ends quietly.
- If `apiVersion` isn't `1`, show one notice and stay idle.
- Without Flow, the command shows "Flow isn't enabled", and checks don't run.

## Failure handling

- **Network or HTTP errors.** All requests use `requestUrl` with
  `throw: false`, and give up after 30 seconds. A failed workspace check is
  skipped for that run; others continue. One notice per workspace and kind of
  problem per session ("Couldn't reach Linear for Acme"); details go in
  the settings status row.
- **Errors Linear reports** (a GraphQL `errors` array): the notice shows
  Linear's message.
- **Bad key** (HTTP 401, or a GraphQL authentication error). A notice that
  points to settings. The workspace stays idle until the key changes.
- **Rate limits** (HTTP 429, or a `RATELIMITED` GraphQL error). Skip that
  workspace until the next interval. At one or two queries per workspace
  every five minutes, this shouldn't happen.
- **Missing secret.** A workspace whose secret name has no value on this
  device (secrets are stored per device) is skipped without a notice. Its
  status row says "No API key on this device".
- **Key for the wrong workspace.** Checks skip the workspace with a status
  error and one notice; the add modal refuses with the same message.
- **Tickets the key can't see.** Left alone, listed in the status row, one
  notice per session.
- **Unparseable URL or unknown workspace** in the add modal: an inline error,
  nothing added.
- **Several devices or vaults.** Each device with a key checks on its own.
  Completing twice is harmless.

## For later

Not built now.

- **Adding from Linear.** An `obsidian://flow-linear?url=…` URI handler
  (`registerObsidianProtocolHandler`) that opens the add modal with the URL
  filled in, so a browser bookmarklet on a Linear ticket page could send it to
  Obsidian. This replaces adding via a shared label.
- **Assigned tickets view.** A Flow Linear view listing the tickets assigned
  to each key's user in chosen states (for example Todo), across the
  configured workspaces, to pick from. Each pick goes through the same "keep
  the title or write your own" step as pasting a link. It's read-only and per
  person, and needs no change to Flow's API. Open points: which states to
  show (configurable per workspace, since state names vary by team), and
  marking tickets that are already in Focus.

## Guidelines compliance

Sources: Obsidian's
[Developer policies](https://docs.obsidian.md/community-directory/developer-policies),
[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins),
[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines),
[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin),
[Community directory FAQ](https://docs.obsidian.md/community-directory/faq),
[Store secrets](https://docs.obsidian.md/Plugins/Guides/Store+secrets),
[Migrate to declarative settings](https://docs.obsidian.md/Plugins/Guides/Migrate+to+declarative+settings),
the [obsidianmd ESLint plugin](https://github.com/obsidianmd/eslint-plugin)
0.4.2 and the blog posts
[The future of Obsidian plugins](https://obsidian.md/blog/future-of-plugins/)
(12 May 2026) and
[Less is safer](https://obsidian.md/blog/less-is-safer/) (19 Sep 2025).

### What's changed since the original guidelines

- **The Community directory** (community.obsidian.md, launched 12 May 2026)
  replaces the PR to `obsidian-releases`. You sign in, link GitHub, and add
  the repo.
- **Every release is scanned automatically**, not only the first
  submission. Sections: Manifest, Releases, Source code, and Build
  verification. Errors block installation, warnings don't. "Review branch"
  runs a preview scan before you release.
- **Build verification**: the scanner runs the first of `build`,
  `build:plugin` or `compile` and checks that the output matches the release
  `main.js`. So `build` must be the production build, and builds must be
  repeatable from the committed lockfile.
- **Scanner ignore list.** Tests, scripts and docs are skipped only when the
  folders are named exactly as on the list (`tests`, `__mocks__`, `scripts`,
  `docs`, `*.mjs`, `*.cjs`, …).
- **Artifact attestations** for release assets feed the public scorecard.
  Obsidian's example release workflow added an attestation step in July 2026.
- **SecretStorage** (Obsidian 1.11.4) is the recommended place for API keys,
  instead of `data.json`.
- **Declarative settings** (Obsidian 1.13). The ESLint rule
  `settings-tab/prefer-setting-definitions` warns on tabs without
  `getSettingDefinitions()`, and Flow's lint fails on warnings.
- **Coming soon**: plugins will declare capability disclosures (network, file
  system, clipboard), and authors can be verified. Write the README network
  section now so it carries straight over.

### Rules that apply to Flow Linear

| Rule                                                                                            | How Flow Linear meets it                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disclose network use in the README, naming the services and why | README "Network use" section: only `api.linear.app`, with your own read-only API keys, to read the tickets you add and the states of tickets in Focus |
| Disclose any account required                                                                   | README says a Linear account, and Flow, are required                                                                                                |
| No client-side telemetry, no ads, no self-updating, no obfuscation                              | None; plain esbuild output, minified only as Flow does                                                                                              |
| LICENSE file that GitHub recognises                                                             | Same licence text as Flow (GPL-3.0-or-later, full text) so GitHub's licence check passes                                                            |
| Respect Obsidian's trademark; plugin id can't contain `obsidian`                                | id `flow-linear`, name "Flow Linear"                                                                                                                |
| `manifest.json` description: action statement, ≤250 characters, ends with a full stop, no emoji | "Add Linear tickets to Flow's Focus list and complete them when they're done in Linear." |
| Appropriate `minAppVersion`                                                                     | `1.13.0` (declarative settings; SecretStorage needs 1.11.4)                                                                                         |
| Node.js/Electron APIs only with `isDesktopOnly`                                                 | None used, but `isDesktopOnly: true` for now (Ben's decision 2): keys aren't yet entered on phones                                                 |
| No `fundingUrl` unless taking donations                                                         | Omitted                                                                                                                                             |
| Command ids without the plugin id; no default hotkeys                                           | `add-ticket-to-focus`, no hotkey                                                                                                                    |
| Remove sample code and placeholder names                                                        | Not started from the sample plugin; `no-sample-code` and `sample-names` lint rules check it                                                         |
| Use `requestUrl`, not `fetch`                                                                   | All Linear calls go through one `requestUrl` wrapper; also avoids CORS                                                                              |
| No `innerHTML`/`outerHTML`/`insertAdjacentHTML`                                                 | Modal and settings built with `createEl`/`setText`; ticket titles are always plain text                                                             |
| Clean up on unload | `registerInterval`, `registerEvent`, startup timer cleared and checker stopped in `onunload` |
| Window-aware timers and documents (popout windows)                                              | `window.setInterval`/`activeWindow.setTimeout` per `prefer-window-timers`; `activeDocument` where needed                                            |
| Avoid the global `app`                                                                          | Use `this.app` throughout                                                                                                                           |
| Sentence case UI; no "settings" in headings; `setHeading` not `<h2>`                            | Declarative groups provide headings; `obsidianmd/ui/sentence-case` with `Linear` and `Flow` added as brands                                         |
| No hardcoded styles                                                                             | Classes in `styles.css`, prefixed `flow-linear-`; no `element.style`                                                                                |
| Avoid needless console logging | Errors via `console.error`, and one `console.warn` when a deleted ticket's item is completed; no routine logging |
| Handle promises                                                                                 | `no-misused-promises` and `no-floating-promises`; fire-and-forget calls use `void` with `.catch` that records the status                            |
| Store API keys in SecretStorage | Keys stored with `app.secretStorage.setSecret` under a name the plugin chooses; settings store only that name. Obsidian's guide shows `SecretComponent`, but no lint rule or policy requires it |
| Declarative settings tab | `getSettingDefinitions()` with a `list` for workspaces (each row a `render` with a Change key button); no `display()` |
| Supply chain: few dependencies, exact pins, lockfile, no postinstall                            | No runtime dependencies (GraphQL sent as plain strings over `requestUrl`); dev dependencies pinned to exact versions; `package-lock.json` committed |

## Tooling

Copied from Flow where it fits:

- esbuild build (`npm run build` = `tsc -noEmit -skipLibCheck && node
esbuild.config.mjs production`), `npm run dev`.
- `eslint.config.mjs` using `obsidianmd.configs.recommended`
  (`eslint-plugin-obsidianmd` 0.4.2) with the same ignores as Flow, `Linear`
  and `Flow` added to the sentence-case brands, and `npm run lint` failing on
  warnings.
- Prettier with `npm run format` / `format:check`.
- Jest with ts-jest, a `tests/__mocks__/obsidian.ts` mock that includes
  `requestUrl`, and an 80% coverage threshold.
- Husky: `pre-commit` runs `gitleaks protect --staged`; `pre-push` runs
  `npm run lint` and `npm run audit:prod`.
- GitHub Actions: `ci.yaml` (format check, lint, build, test, audit) and
  `release.yaml` (on tag: verify, build, attest `main.js`, `manifest.json`,
  `styles.css`, upload to a draft release).
- `scripts/release.ts` and `docs/RELEASING.md` adapted from Flow, with the
  same approval steps in `AGENTS.md`. Leave out the beta release script until
  it's needed.
- `versions.json` and `manifest.json` kept in step by the release script.

Different from Flow: dev dependencies pinned to exact versions (Flow uses
`^`), and no runtime dependencies at all.

## Testing

- **`planCompletionCheck`**: completed, cancelled and trashed tickets complete
  their items; open states don't; a ticket Linear didn't return is listed as
  not visible and never completed; an open ticket with a new identifier is
  relinked; items whose ticket wasn't looked up are left. Grouping keeps only
  the workspace's unfinished linked items.
- **URL parsing**: valid forms (with and without slug, query, fragment) and
  rejects (other hosts, project or team URLs, missing identifier).
- **Linear client**: GraphQL responses stored as JSON in `tests/fixtures/`,
  served through the `requestUrl` mock. Covers batching, pagination, the
  one-by-one lookup for moved and missing tickets, "Entity not found", 401,
  429, a GraphQL `errors` array, the 30-second timeout, and that no request
  is a mutation. The tests check the client's parsing and error mapping, not
  the mock.
- **Completion checker**: runs against an in-memory Focus store that
  implements `FlowApi` and an in-memory Linear workspace. Covers completing
  and leaving items, trashed tickets (logged only after completing), tickets
  the key can't see, a key for another workspace, relinking a moved ticket
  and not matching a reused identifier afterwards, repeat checks doing
  nothing, items that have already gone, failed writes, workspaces with the
  same identifier, each failure kind and its notice, Flow unloading
  mid-check, stopping, and one check at a time with a single queued
  follow-up.
- **Settings and modals**: the add modal's handling of an unknown workspace,
  a key for another workspace, a link outside the workspace, a closed ticket
  and empty wording; Find and Add pressed twice; a modal closed mid-lookup;
  the workspace form; the old Flow warning.
- **Manual check in Obsidian** before the first release: in a Linear test
  team, add tickets by link, complete and cancel them in Linear, delete one,
  go offline and come back.

Fixtures are to be recorded once by hand from a real workspace, with names and
URLs replaced by test values. The first set was written by hand in Linear's
response shape, since no workspace was available while building; replace them
with recorded ones during the manual check.

## Decisions (Ben, 2026-11-04)

1. **Whose labelled tickets:** superseded by decision 5.
2. **Mobile:** desktop only for now. Keys stay per device in SecretStorage;
   entering them on a phone is left for later.
3. **Licence:** GPL-3.0-or-later, as Flow.
4. **Distribution:** submit to the Community directory, so the first release
   must pass the automated scan and ship with artifact attestations.
5. **No Linear label.** A shared workspace label collides between people and
   between vaults, so adding from Linear via a label is dropped. Flow Linear
   adds tickets only by link, completes Focus items when tickets close, and
   only reads from Linear, with a read-only key.
