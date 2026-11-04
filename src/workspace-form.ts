// ABOUTME: Checks a Linear API key for a new or existing workspace before it's saved.
// ABOUTME: Kept apart from the modals so each refusal can be tested.

import { wrongWorkspaceMessage } from "./completion";
import { LinearOrganization, LinearWorkspaceClient } from "./linear-client";
import { secretNameFor, WorkspaceSettings } from "./settings";

export interface WorkspaceFormInput {
  apiKey: string;
  displayName: string; // Empty means use the organisation's name
  defaultSphere: string;
}

export type WorkspaceFormResult =
  | { ok: true; workspace: WorkspaceSettings; apiKey: string }
  | { ok: false; error: string };

export type KeyCheckResult = { ok: true; apiKey: string } | { ok: false; error: string };

async function readOrganization(
  apiKey: string,
  createClient: (apiKey: string) => LinearWorkspaceClient
): Promise<{ ok: true; organization: LinearOrganization } | { ok: false; error: string }> {
  if (apiKey === "") return { ok: false, error: "Paste your Linear API key." };
  try {
    return { ok: true, organization: await createClient(apiKey).getOrganization() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Couldn't check the key with Linear: ${message}` };
  }
}

/** Check the key for a new workspace; Linear supplies the workspace's name and urlKey. */
export async function checkWorkspace(
  input: WorkspaceFormInput,
  existing: WorkspaceSettings[],
  createClient: (apiKey: string) => LinearWorkspaceClient
): Promise<WorkspaceFormResult> {
  const apiKey = input.apiKey.trim();
  const result = await readOrganization(apiKey, createClient);
  if (!result.ok) return result;
  const { organization } = result;

  if (existing.some((workspace) => workspace.urlKey === organization.urlKey)) {
    return {
      ok: false,
      error: `${organization.name} (${organization.urlKey}) is already set up. Use its "Change key" button to replace the key.`,
    };
  }

  return {
    ok: true,
    apiKey,
    workspace: {
      urlKey: organization.urlKey,
      displayName: input.displayName.trim() || organization.name,
      apiKeySecretName: secretNameFor(organization.urlKey),
      defaultSphere: input.defaultSphere,
    },
  };
}

/** Check a replacement key for an existing workspace: it must belong to the same workspace. */
export async function checkReplacementKey(
  apiKey: string,
  workspace: WorkspaceSettings,
  createClient: (apiKey: string) => LinearWorkspaceClient
): Promise<KeyCheckResult> {
  const trimmed = apiKey.trim();
  const result = await readOrganization(trimmed, createClient);
  if (!result.ok) return result;
  if (result.organization.urlKey !== workspace.urlKey) {
    return { ok: false, error: wrongWorkspaceMessage(workspace, result.organization.urlKey) };
  }
  return { ok: true, apiKey: trimmed };
}
