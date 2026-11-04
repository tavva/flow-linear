# Flow Linear

Flow Linear adds Linear tickets to the Focus list of the
[Flow](https://github.com/tavva/flow) plugin for Obsidian, and completes them in Focus
when they're done in Linear.

- Run **Add Linear ticket to Focus**, paste a ticket link, keep the ticket's title
  or write your own wording, and pick a sphere. Adding the same ticket again adds
  another step for it.
- Every few minutes Flow Linear checks the tickets behind your unfinished Focus
  items. When a ticket is completed or cancelled in Linear, or deleted, its Focus
  items are completed.

Flow Linear only reads from Linear. It never changes tickets, labels or anything
else there.

## Requirements

- Obsidian 1.13 or later, on desktop.
- Flow, in a version that offers the Focus API (API version 1). Flow Linear works
  only through that API and does nothing while Flow is disabled.
- A Linear account, and a Linear personal API key for each workspace you want to
  use. Read access is all it needs.

## Setting up

> **Update Flow on every device first.** If any device that syncs this vault runs
> Flow 1.3.12 or earlier, it will delete your Linear items from Focus whenever its
> Focus view refreshes, and that deletion syncs to every device. Before installing
> Flow Linear, update Flow on every device that syncs this vault, including ones
> where you won't install Flow Linear. Flow Linear won't run on a device whose Flow
> is too old, but it can't see the other devices.

1. In Linear's settings, under Security & access, create a personal API key. Give
   it **Read** permission only; Flow Linear never writes to Linear. You can also
   limit the key to the teams whose tickets you'll add. (Your workspace's admins
   may need to allow members to create API keys.)
2. In Obsidian, open **Settings → Flow Linear** and click **Add workspace**.
3. Choose or create a secret for the API key. Flow Linear checks the key with Linear
   and fills in the workspace for you.
4. Optionally give the workspace a display name (shown on its Focus items) and pick
   the sphere new items go into.

Repeat for each Linear workspace. Under **Checking Linear** you can change how
often Flow Linear checks for finished tickets (default every 5 minutes; the first
check is 30 seconds after Obsidian starts). **Status** shows each workspace's last
check or last error.

API keys are stored per device, so enter them on each computer where you want
Flow Linear to run. A device without a key leaves that workspace alone. Running it
on several devices is harmless: completing an item twice keeps the first time.

## Network use

Flow Linear connects to one service: Linear's API at `https://api.linear.app`,
using the API keys you enter. It sends requests:

- when you add a workspace, to check the key and read the workspace's name;
- when you add a ticket by link, to read that ticket;
- every few minutes (5 by default), to read the state of the tickets behind your
  unfinished Focus items.

It reads ticket IDs, titles, links and states. It sends no changes to Linear.
Nothing is sent anywhere else: no telemetry, analytics or ads.

## What it stores

- **Settings** in the plugin's `data.json`: your workspaces (name, URL key, default
  sphere and the _name_ of the secret holding the key), the check interval, and
  whether you've dismissed the Flow warning.
- **API keys** in Obsidian's secret storage on each device, never in `data.json`.
- **Focus items** in Flow's focus file, written through Flow's API. The link to each
  ticket lives on its Focus item.

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
