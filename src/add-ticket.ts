// ABOUTME: The steps behind "Add Linear ticket to Focus": find the ticket from a URL, then add it.
// ABOUTME: Kept apart from the modal so each outcome, including refusals, can be tested.

import { FlowApi, SOURCE_NAME } from "./flow-api";
import { LinearTicket, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearData, WorkspaceSettings } from "./settings";
import { parseTicketUrl, ticketKey } from "./ticket-url";

export interface AddTicketDeps {
  getFlowApi(): FlowApi | null;
  getData(): FlowLinearData;
  saveData(): Promise<void>;
  getSecret(name: string): string | null;
  createClient(apiKey: string): LinearWorkspaceClient;
  requestSync(): void;
}

export interface FoundTicket {
  workspace: WorkspaceSettings;
  ticket: LinearTicket;
  ticketKey: string;
}

export type LookUpResult = { ok: true; found: FoundTicket } | { ok: false; error: string };

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

export class AddTicket {
  constructor(private deps: AddTicketDeps) {}

  async lookUp(url: string): Promise<LookUpResult> {
    const ref = parseTicketUrl(url);
    if (!ref) {
      return {
        ok: false,
        error:
          "That isn't a Linear ticket link. It should look like https://linear.app/team/issue/ABC-123.",
      };
    }
    const { workspaces } = this.deps.getData().settings;
    const workspace = workspaces.find((w) => w.urlKey === ref.urlKey);
    if (!workspace) {
      const known = workspaces.map((w) => `${w.displayName} (${w.urlKey})`).join(", ");
      return {
        ok: false,
        error: known
          ? `The workspace "${ref.urlKey}" isn't set up. Set up: ${known}.`
          : "No Linear workspaces are set up yet. Add one in Flow Linear's settings.",
      };
    }
    const apiKey = this.deps.getSecret(workspace.apiKeySecretName);
    if (!apiKey) {
      return {
        ok: false,
        error: `There's no API key for ${workspace.displayName} on this device.`,
      };
    }

    let ticket: LinearTicket | null;
    try {
      ticket = await this.deps.createClient(apiKey).getTicketByIdentifier(ref.identifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Couldn't fetch the ticket from Linear: ${message}` };
    }
    if (!ticket || ticket.trashed) {
      return { ok: false, error: `${ref.identifier} wasn't found in ${workspace.displayName}.` };
    }
    if (CLOSED_STATE_TYPES.has(ticket.stateType)) {
      const state = ticket.stateType === "canceled" ? "cancelled" : "completed";
      return { ok: false, error: `${ticket.identifier} is already ${state} in Linear.` };
    }
    return { ok: true, found: { workspace, ticket, ticketKey: ticketKey(ref) } };
  }

  /** Add the ticket to Focus. Returns an error message, or null once it's added. */
  async add(found: FoundTicket, wording: string, sphere: string): Promise<string | null> {
    const api = this.deps.getFlowApi();
    if (!api) return "Flow isn't enabled";
    if (wording.trim() === "") return "Enter the wording for the Focus item.";
    if (sphere.trim() === "") return "Choose a sphere.";

    try {
      await api.addFocusItem({
        text: wording.trim(),
        sphere,
        sourceName: SOURCE_NAME,
        sourceLabel: found.workspace.displayName,
        url: found.ticket.url,
        externalId: found.ticket.identifier,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Couldn't add the ticket to Focus: ${message}`;
    }

    const { tickets } = this.deps.getData();
    if (tickets[found.ticketKey]?.label !== "synced") {
      tickets[found.ticketKey] = { issueId: found.ticket.id, label: "add-pending" };
      await this.deps.saveData();
    }
    this.deps.requestSync();
    return null;
  }
}
