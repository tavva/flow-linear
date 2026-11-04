# Flow Linear design

## Overview

Flow Linear is an Obsidian plugin that puts chosen Linear tickets into Flow's
Focus list and keeps them in step with a Linear label. Nothing comes in from
Linear unless you ask for it, in one of two ways:

1. Run "Add Linear ticket to Focus", paste a ticket URL, and keep the ticket's
   title or write your own wording.
2. Add the `focus` label to a ticket in Linear. Flow Linear picks it up on its
   next check.

The label then works both ways. It sits on a ticket exactly while at least one
unfinished Focus item links to that ticket.

Flow knows nothing about Linear. Flow Linear works only through Flow's Focus
API, designed in Flow's `docs/plans/2026-11-04-focus-api-design.md`. Names
here match that design.

Out of scope: Linear tickets anywhere in Flow other than Focus, creating or
editing tickets, closing tickets from Flow, sources other than Linear.

## Terms

- **Workspace**: a Linear workspace (Linear calls it an organisation), with
  its own API key. Ben uses several.
- **Ticket key**: `<workspace urlKey>/<identifier>`, for example
  `acme/ABC-123`. Identifiers are unique only within a workspace, so the
  key includes the workspace.
- **Linked item**: an external Focus item with `sourceName: "linear"` whose
  `url` points at the ticket.
- **Unfinished**: a linked item without `completedAt`.

## Settings

The settings tab is declarative (`getSettingDefinitions()`, Obsidian 1.13), so
`minAppVersion` is `1.13.0`.

- **Workspaces**: a `type: 'list'` setting. Adding one opens a form modal:
  - _API key_: a `SecretComponent`. Settings store the secret's name, never
    its value (see "Secrets" below).
  - On save the plugin queries `viewer { organization { name urlKey } }` with
    the key. That checks the key works and fills in the workspace's `urlKey`,
    so you never type the slug.
  - _Display name_: defaults to the organisation's name. Used as the Focus
    item's `sourceLabel` (the chip in Focus and the heading on the TV board).
  - _Default sphere_: the sphere new items from this workspace get.
  - Each row shows its display name and `urlKey`; rows can be deleted.
- **Label name**: one text setting for all workspaces, default `focus`.
- **Check every**: minutes between checks, default 5, minimum 1.
- **Status**: a read-only row per workspace with the last successful check
  time or the last error.

Stored settings:

```typescript
interface FlowLinearSettings {
  workspaces: WorkspaceSettings[];
  labelName: string; // Default "focus"
  checkIntervalMinutes: number; // Default 5
}

interface WorkspaceSettings {
  urlKey: string; // From the API, e.g. "acme"
  displayName: string; // e.g. "Acme"
  apiKeySecretName: string; // Name in Obsidian's SecretStorage
  defaultSphere: string;
}
```

## Adding a ticket from a URL

Command: "Add Linear ticket to Focus" (id `add-ticket-to-focus`, no default
hotkey).

1. A modal asks for the URL. Accepted form:
   `https://linear.app/<urlKey>/issue/<IDENTIFIER>[/<title-slug>]`, with or
   without query string or fragment.
2. `urlKey` picks the workspace. If none matches, the modal says which
   workspaces are set up and saves nothing.
3. The plugin fetches the ticket with `issue(id: "<IDENTIFIER>")` (Linear
   accepts the identifier there) and gets its UUID, title, state type and
   canonical URL.
4. The modal shows the title in an editable wording field and the sphere
   (default from the workspace) in a text field. Add saves; Escape cancels.
5. If the ticket's state type is `completed` or `canceled`, the modal says so
   and saves nothing.
6. On Add: `api.addFocusItem({ text, sphere, sourceName: "linear",
sourceLabel: displayName, url: canonicalUrl, externalId: identifier })`,
   then the ticket's label state becomes `add-pending` (unless it is already
   `synced`) and a sync runs straight away.

Pasting a ticket that already has linked items adds another step for it. It
doesn't replace the existing ones.

## What the plugin stores

The link from a Focus item to its ticket lives on the Focus item itself: the
`url` carries the workspace and identifier, and `externalId` is the
identifier. Flow Linear parses the URL to get the ticket key. The Focus file
syncs between devices, so every device sees the same links without the plugin
keeping its own copy.

The plugin's own data (`data.json`) holds what Focus can't:

```typescript
interface FlowLinearData {
  settings: FlowLinearSettings;
  tickets: Record<string, TicketRecord>; // Keyed by ticket key
}

interface TicketRecord {
  issueId: string; // Linear UUID, needed by the label mutations
  label: "synced" | "add-pending" | "remove-pending";
}
```

`label` is the agreed `labelSynced` idea with the direction made explicit:

- `synced`: Flow Linear has seen the label on the ticket in Linear.
- `add-pending`: there are unfinished linked items and the label still needs
  adding.
- `remove-pending`: there are no unfinished linked items and the label still
  needs removing. The record isn't deleted until the removal succeeds,
  otherwise the next check would see the label and import the ticket again.

A ticket with no record is one Flow Linear doesn't track.

## Label sync

### When it runs

- Once Flow's API is available after `onLayoutReady` (see "Finding Flow").
- Every `checkIntervalMinutes`, via `registerInterval(window.setInterval(…))`.
- On a Focus change event for `sourceName: "linear"`, debounced by two
  seconds, so completing or removing an item reaches Linear quickly.
- After "Add Linear ticket to Focus".

Only one sync runs at a time. A request made during a run queues a single
follow-up run.

### What it fetches

Per workspace, one GraphQL query (`POST https://api.linear.app/graphql`,
`Authorization: <api key>`):

- tickets with the label: `issues(filter: { labels: { name: { eqIgnoreCase:
$label } } })` with id, identifier, url, title, state type, paginated;
- tickets by UUID for every tracked record in that workspace, with id, state
  type and label names. These are fetched even when their label has gone,
  which a filter on the label alone would miss.

Plus once per workspace per session, the label's id: a workspace-level label
(`team: null`) named `labelName`. If there's none, the first sync that needs
it creates it with `issueLabelCreate` (no `teamId`).

### Deciding what to do

A pure function makes every decision:

```typescript
function decideSyncActions(input: {
  workspace: WorkspaceSettings;
  labelledTickets: LinearTicket[]; // Currently carry the label
  trackedTickets: LinearTicket[]; // State of every tracked ticket
  records: Record<string, TicketRecord>; // This workspace's records
  focusItems: ExternalFocusItem[]; // sourceName "linear", this workspace
}): SyncAction[];

type SyncAction =
  | { type: "import"; ticket: LinearTicket } // Add a Focus item, record "synced"
  | { type: "removeItems"; itemIds: string[]; ticketKey: string } // And delete record
  | { type: "completeItems"; itemIds: string[] }
  | { type: "addLabel"; ticketKey: string; issueId: string }
  | { type: "removeLabel"; ticketKey: string; issueId: string }
  | { type: "setRecord"; ticketKey: string; record: TicketRecord | null };
```

For each ticket, in this order:

1. **Closed in Linear.** State type `completed` or `canceled` → complete
   every unfinished linked item. From then on it has none, so rule 5 removes
   the label.
2. **Label added in Linear.** Labelled, no record, no unfinished linked item →
   import: `addFocusItem` with the ticket title as wording, the workspace's
   default sphere, and record `synced`.
3. **Label removed in Linear.** Record `synced`, ticket no longer labelled →
   remove every unfinished linked item and delete the record. Completed
   linked items stay, so "done today" isn't lost.
4. **Label to add.** Unfinished linked items, ticket not labelled, record
   missing or `add-pending` → `addLabel`; on success the record becomes
   `synced`. A missing record here means the item was added on another device
   (or the record was lost), so the plugin treats it as `add-pending`.
5. **Label to remove.** No unfinished linked items, record `synced` or
   `remove-pending` → `removeLabel` if the ticket still has it, then delete
   the record.
6. **Label present and wanted.** Labelled with unfinished linked items →
   record `synced`.

Rule 3 is the only one that tells "removed in Linear" apart from "not yet
added". It does so because `synced` means the plugin has seen the label
there.

A labelled ticket that has only completed linked items is imported again (rule
2), because it has no unfinished item. Adding the label in Linear always means
"put this in Focus".

### Carrying out actions

- Focus writes go through the API: `addFocusItem`, `completeFocusItem`,
  `removeFocusItem`. Each call holds Flow's focus file lock.
- Label changes use `issueAddLabel(id, labelId)` and
  `issueRemoveLabel(id, labelId)`, which touch only that one label and leave
  the ticket's other labels alone (unlike `issueUpdate(labelIds)`).
- Records are saved after each action succeeds. A failed action leaves its
  record unchanged, so the next run tries again.
- The plugin's own API calls trigger Focus change events. Those request a
  sync, which then finds nothing to do.

## Finding Flow

As set out in the Focus API design:

- In `onLayoutReady`, look up `app.plugins.getPlugin("flow")?.api`.
  `app.plugins` isn't in Obsidian's public typings, so `src/flow-api.ts`
  declares the narrow type used, with a copy of Flow's `FlowApi` interface.
- Listen for `flow:api-ready` and `flow:api-unloaded` workspace events to cope
  with Flow being enabled, disabled or reloaded later.
- If `apiVersion` isn't `1`, show one notice and stay idle.
- Without Flow, the command shows "Flow isn't enabled", and sync doesn't run.
- `onFocusChange("linear", …)` returns an unsubscribe function, called on
  `onunload` and on `flow:api-unloaded`.

Flow's API has no way to list spheres yet, so the default sphere is a plain
text field. Adding `getSpheres(): string[]` to `FlowApi` would allow a
dropdown. It's a small addition that doesn't break callers and can come
later.

## Failure handling

- **Network or HTTP errors.** All requests use `requestUrl` with
  `throw: false`. A failed workspace check is skipped for that run; others
  continue. One notice per workspace per session ("Couldn't reach Linear for
  Acme"); details go in the settings status row. Pending records stay
  pending.
- **Bad key** (HTTP 401, or a GraphQL authentication error). Same as above,
  with a notice that points to settings. The workspace stays idle until the
  key changes.
- **Rate limits** (HTTP 429, or a `RATELIMITED` GraphQL error). Skip that
  workspace until the next interval. At one or two queries per workspace
  every five minutes, this shouldn't happen.
- **Missing secret.** A workspace whose secret name has no value on this
  device (secrets are stored per device, see below) is skipped without a
  notice. Its status row says "No API key on this device".
- **Unparseable URL or unknown workspace** in the add modal: an inline error,
  nothing saved.
- **Ticket deleted in Linear** (a tracked UUID comes back null): handled as
  closed. Linked items are completed and the record deleted.
- **Two devices syncing at once.** Both might import the same newly labelled
  ticket before the Focus file syncs. Before importing, a device re-reads
  Focus items through `getFocusItems("linear")` while the action runs, which
  narrows that window but doesn't close it. A duplicate shows up as two Focus
  items for one ticket, and you can remove one. Because keys are stored per
  device, only devices where you've entered a key take part.

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
| Disclose network use in the README, naming the services and why                                 | README "Network use" section: only `api.linear.app`, with your own API keys, to read labelled and tracked tickets and add or remove one label       |
| Disclose any account required                                                                   | README says a Linear account, and Flow, are required                                                                                                |
| No client-side telemetry, no ads, no self-updating, no obfuscation                              | None; plain esbuild output, minified only as Flow does                                                                                              |
| LICENSE file that GitHub recognises                                                             | Same licence text as Flow (GPL-3.0-or-later, full text) so GitHub's licence check passes                                                            |
| Respect Obsidian's trademark; plugin id can't contain `obsidian`                                | id `flow-linear`, name "Flow Linear"                                                                                                                |
| `manifest.json` description: action statement, ≤250 characters, ends with a full stop, no emoji | "Add Linear tickets to Flow's Focus list and keep them in step with a Linear label."                                                                |
| Appropriate `minAppVersion`                                                                     | `1.13.0` (declarative settings; SecretStorage needs 1.11.4)                                                                                         |
| Node.js/Electron APIs only with `isDesktopOnly`                                                 | None used; `isDesktopOnly: false`, works on mobile                                                                                                  |
| No `fundingUrl` unless taking donations                                                         | Omitted                                                                                                                                             |
| Command ids without the plugin id; no default hotkeys                                           | `add-ticket-to-focus`, no hotkey                                                                                                                    |
| Remove sample code and placeholder names                                                        | Not started from the sample plugin; `no-sample-code` and `sample-names` lint rules check it                                                         |
| Use `requestUrl`, not `fetch`                                                                   | All Linear calls go through one `requestUrl` wrapper; also avoids CORS                                                                              |
| No `innerHTML`/`outerHTML`/`insertAdjacentHTML`                                                 | Modal and settings built with `createEl`/`setText`; ticket titles are always plain text                                                             |
| Clean up on unload                                                                              | `registerInterval`, `registerEvent`, Flow change-callback unsubscribed in `onunload`                                                                |
| Window-aware timers and documents (popout windows)                                              | `window.setInterval`/`activeWindow.setTimeout` per `prefer-window-timers`; `activeDocument` where needed                                            |
| Avoid the global `app`                                                                          | Use `this.app` throughout                                                                                                                           |
| Sentence case UI; no "settings" in headings; `setHeading` not `<h2>`                            | Declarative groups provide headings; `obsidianmd/ui/sentence-case` with `Linear` and `Flow` added as brands                                         |
| No hardcoded styles                                                                             | Classes in `styles.css`, prefixed `flow-linear-`; no `element.style`                                                                                |
| Avoid needless console logging                                                                  | Errors only, via `console.error`, no routine logging                                                                                                |
| Handle promises                                                                                 | `no-misused-promises` and `no-floating-promises`; fire-and-forget calls use `void` with `.catch` that records the status                            |
| Store API keys in SecretStorage                                                                 | `SecretComponent` in the workspace form; settings store only the secret name                                                                        |
| Declarative settings tab                                                                        | `getSettingDefinitions()` with a `list` for workspaces and `render` for the `SecretComponent` row; no `display()`                                   |
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

- **`decideSyncActions`**: table-driven tests for each rule. Import, Linear
  removal with `synced`, pending add (including a missing record, as when the
  item was added on another device), pending remove, closed ticket, deleted
  ticket, a relabelled ticket with only completed items, several items for
  one ticket with one removed (label stays), two workspaces with the same
  identifier.
- **URL parsing**: valid forms (with and without slug, query, fragment) and
  rejects (other hosts, project or team URLs, missing identifier).
- **Linear client**: recorded GraphQL responses stored as JSON in
  `tests/fixtures/`, served through the `requestUrl` mock. Covers pagination,
  null tickets, 401, 429, a GraphQL `errors` array, and label lookup and
  creation. The tests check the client's parsing and error mapping, not the
  mock.
- **Sync runner**: carries out decided actions against an in-memory Focus
  store that implements `FlowApi`. Checks that records change only after an
  action succeeds, that one run happens at a time with a single queued
  follow-up, and that its own change events lead to no further actions.
- **Settings and modal**: the add modal's handling of an unknown workspace,
  a closed ticket and empty wording.
- **Manual check in Obsidian** before the first release: in a Linear test
  team, add and remove the label in Linear and in Flow, close a ticket, go
  offline and come back, and run on two devices.

Fixtures are recorded once by hand from a real workspace, with names and
URLs replaced by test values.

## Decisions (Ben, 2026-11-04)

1. **Whose labelled tickets:** import any ticket carrying the label, as
   designed.
2. **Mobile:** desktop only for now. Keys stay per device in SecretStorage;
   entering them on a phone is left for later.
3. **Licence:** GPL-3.0-or-later, as Flow.
4. **Distribution:** submit to the Community directory, so the first release
   must pass the automated scan and ship with artifact attestations.
