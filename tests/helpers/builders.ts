// ABOUTME: Builders for Linear tickets, Focus items and workspaces used across tests.
// ABOUTME: Keeps test cases short by filling in every field a case doesn't care about.

import { ExternalFocusItem } from "../../src/flow-api";
import { LinearTicket } from "../../src/linear-client";
import { WorkspaceSettings } from "../../src/settings";

export function workspace(urlKey = "testco", overrides: Partial<WorkspaceSettings> = {}) {
  return {
    urlKey,
    displayName: urlKey === "testco" ? "Testco" : urlKey,
    apiKeySecretName: `linear-${urlKey}`,
    defaultSphere: "work",
    ...overrides,
  } satisfies WorkspaceSettings;
}

export function ticket(
  identifier: string,
  overrides: Partial<LinearTicket> & { urlKey?: string } = {}
): LinearTicket {
  const { urlKey = "testco", ...rest } = overrides;
  return {
    id: `uuid-${urlKey}-${identifier}`,
    identifier,
    url: `https://linear.app/${urlKey}/issue/${identifier}/some-title`,
    title: `Title of ${identifier}`,
    stateType: "started",
    trashed: false,
    ...rest,
  };
}

let nextItem = 1;

export function focusItem(
  identifier: string,
  overrides: Partial<ExternalFocusItem> & { urlKey?: string } = {}
): ExternalFocusItem {
  const { urlKey = "testco", ...rest } = overrides;
  return {
    id: `item-${nextItem++}`,
    text: `Work on ${identifier}`,
    sphere: "work",
    addedAt: 1,
    contexts: [],
    external: {
      sourceName: "linear",
      sourceLabel: "Testco",
      url: `https://linear.app/${urlKey}/issue/${identifier}/some-title`,
      externalId: identifier,
    },
    ...rest,
  };
}
