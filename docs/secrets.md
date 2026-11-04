# Secrets register

Where each secret lives. Never put secret values here.

| Variable                                    | Provider and account                                           | Purpose                                                                   | Scope                                                                                           | Where it lives                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linear personal API key (one per workspace) | Linear, Ben's user in each workspace (e.g. Acme) | Read the workspace name, tickets added by link, and the states of tickets in Focus | Personal API key with Read permission only, optionally limited to chosen teams; the plugin sends no mutations | Obsidian SecretStorage on each device where it's entered (local storage keyed to the vault, not synced), under the name `flow-linear-<urlKey>` that the plugin chooses (e.g. `flow-linear-acme`); the plugin's `data.json` stores only that name. Removing the workspace overwrites the secret with an empty value. Not in this repo, CI or any env file. |
| `LINEAR_API_KEY` (probe test key) | Linear, Ben's user in Acme | Run `scripts/probe-linear.mjs` against real Linear to check how it answers the plugin's queries | Personal API key with Read permission only, Acme; the probe sends no mutations | `.env.local` in a local `tavva/build` worktree (git-ignored, never committed), read with `node --env-file=.env.local`. Not in CI. |

Test fixtures in `tests/fixtures/` are Linear GraphQL responses with test names,
IDs and URLs; they contain no keys. Tests use no Linear key and make no network
calls.

GitHub Actions (`ci.yaml`, `release.yaml`) use no secrets of their own: only the
built-in `GITHUB_TOKEN` and the OIDC token that `actions/attest` requests, both
issued per run by GitHub.
