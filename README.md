# Flow Linear

Flow Linear puts chosen Linear tickets into the Focus list of the
[Flow](https://github.com/tavva/flow) plugin for Obsidian, and keeps a Linear label
in step with them.

Nothing comes in from Linear unless you ask for it, in one of two ways:

1. Run **Add Linear ticket to Focus**, paste a ticket link, and keep the ticket's
   title or write your own wording.
2. Add the `flow-focus` label to a ticket in Linear. Flow Linear picks it up on its
   next check.

The label then works both ways: it stays on a ticket while at least one unfinished
Focus item links to it.

- Complete or remove the Focus item and the label comes off the ticket.
- Remove the label in Linear and the ticket's unfinished Focus items go.
- Complete or cancel the ticket in Linear and its Focus items are completed.

One ticket can have several Focus items, one per step. Adding the same ticket again
adds another step.

## Requirements

- Obsidian 1.13 or later, on desktop.
- Flow, in a version that offers the Focus API (API version 1). Flow Linear works
  only through that API and does nothing while Flow is disabled.
- A Linear account, and a Linear personal API key for each workspace you want to
  use. The key needs read and write access: writing is used only to add and remove
  the label, and to create the label once if the workspace doesn't have it.

## Setting up

1. In Linear's settings, under Security & access, create a personal API key.
2. In Obsidian, open **Settings → Flow Linear** and click **Add workspace**.
3. Choose or create a secret for the API key. Flow Linear checks the key with Linear
   and fills in the workspace for you.
4. Optionally give the workspace a display name (shown on its Focus items) and pick
   the sphere new items go into.

Repeat for each Linear workspace. Under **Sync** you can change the label name
(default `flow-focus`, the same in every workspace) and how often Flow Linear checks
Linear (default every 5 minutes). **Status** shows each workspace's last check or
last error.

API keys are stored per device, so enter them on each computer where you want
syncing to run. A device without a key leaves that workspace alone.

## Network use

Flow Linear connects to one service: Linear's API at `https://api.linear.app`,
using the API keys you enter. It sends requests:

- when you add a workspace, to check the key and read the workspace's name;
- when you add a ticket by link, to read that ticket;
- every few minutes (5 by default), after Focus changes, and on start-up, to read
  the tickets that carry the label and the tickets Flow Linear is tracking, and to
  add or remove the label on them.

It reads ticket IDs, titles, links, states and label names, and changes only the one
label. It never edits or creates tickets. Nothing is sent anywhere else: no
telemetry, analytics or ads.

## What it stores

- **Settings and ticket records** in the plugin's `data.json`: your workspaces (name,
  URL key, default sphere and the _name_ of the secret holding the key), the label
  name, the check interval, and for each tracked ticket its Linear ID and whether the
  label still needs adding or removing.
- **API keys** in Obsidian's secret storage on each device, never in `data.json`.
- **Focus items** in Flow's focus file, written through Flow's API.

## Development

```bash
npm install
npm run dev           # Build and watch
npm run build         # Type check and production build
npm run lint          # Type check and ESLint (Obsidian's rules), no warnings allowed
npm run format        # Prettier
npm test              # Jest
npm run test:coverage # Jest with the 80% coverage threshold
```

See [docs/RELEASING.md](docs/RELEASING.md) for releases.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
