// ABOUTME: Checks a workspace's API key with Linear and turns the form into workspace settings.
// ABOUTME: Kept apart from the modal so each refusal can be tested.

import { LinearWorkspaceClient } from "./linear-client";
import { WorkspaceSettings } from "./settings";

export interface WorkspaceFormInput {
  apiKeySecretName: string;
  displayName: string; // Empty means use the organisation's name
  defaultSphere: string;
}

export type WorkspaceFormResult =
  | { ok: true; workspace: WorkspaceSettings }
  | { ok: false; error: string };

export async function checkWorkspace(
  input: WorkspaceFormInput,
  existing: WorkspaceSettings[],
  getSecret: (name: string) => string | null,
  createClient: (apiKey: string) => LinearWorkspaceClient
): Promise<WorkspaceFormResult> {
  if (input.apiKeySecretName === "") return { ok: false, error: "Choose an API key." };
  const apiKey = getSecret(input.apiKeySecretName);
  if (!apiKey) return { ok: false, error: "That secret has no value on this device." };

  let organization;
  try {
    organization = await createClient(apiKey).getOrganization();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Couldn't check the key with Linear: ${message}` };
  }

  if (existing.some((workspace) => workspace.urlKey === organization.urlKey)) {
    return { ok: false, error: `${organization.name} (${organization.urlKey}) is already set up.` };
  }

  return {
    ok: true,
    workspace: {
      urlKey: organization.urlKey,
      displayName: input.displayName.trim() || organization.name,
      apiKeySecretName: input.apiKeySecretName,
      defaultSphere: input.defaultSphere,
    },
  };
}
