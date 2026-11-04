# Secrets register

Where each secret lives. Never put secret values here.

| Variable                                    | Provider and account                                           | Purpose                                                                   | Scope                                                                                           | Where it lives                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linear personal API key (one per workspace) | Linear, Ben's user in each workspace (e.g. Acme) | Read labelled and tracked tickets; add, remove and create the Focus label | Personal API key with read and write access (write needed for label changes and label creation) | Obsidian SecretStorage on each device where it's entered (local storage keyed to the vault, not synced); the plugin's `data.json` stores only the secret's name. Not in this repo, CI or any env file. |

Test fixtures in `tests/fixtures/` are Linear GraphQL responses with test names,
IDs and URLs; they contain no keys. Tests use no Linear key and make no network
calls.

GitHub Actions (`ci.yaml`, `release.yaml`) use no secrets of their own: only the
built-in `GITHUB_TOKEN` and the OIDC token that `actions/attest` requests, both
issued per run by GitHub.
