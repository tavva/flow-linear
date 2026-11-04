// ABOUTME: Decides, for one workspace, what a sync must do to Focus, Linear and the stored records.
// ABOUTME: Pure: takes the state of Linear, Focus and the records, and returns actions to carry out.

import { ExternalFocusItem } from "./flow-api";
import { LinearTicket } from "./linear-client";
import { TicketRecord, WorkspaceSettings } from "./settings";
import { parseTicketUrl, ticketKey } from "./ticket-url";

export type SyncAction =
  | { type: "import"; ticketKey: string; ticket: LinearTicket } // Add a Focus item, record "synced"
  | { type: "removeItems"; ticketKey: string; itemIds: string[] } // And delete the record
  | { type: "completeItems"; ticketKey: string; itemIds: string[] }
  | { type: "addLabel"; ticketKey: string; issueId: string } // On success, record "synced"
  | { type: "removeLabel"; ticketKey: string; issueId: string } // On success, delete the record
  // No unfinished items were found, but that might be a passing glitch in the Focus file.
  // The label comes off only once a later pass confirms it.
  | { type: "awaitRemoval"; ticketKey: string }
  | { type: "setRecord"; ticketKey: string; record: TicketRecord | null };

export interface SyncInput {
  workspace: WorkspaceSettings;
  labelName: string;
  labelledTickets: LinearTicket[]; // Currently carry the label
  // Every ticket asked about by UUID (tracked records) or identifier (linked items without a
  // record). A ticket asked about but missing here has been deleted.
  trackedTickets: LinearTicket[];
  records: Record<string, TicketRecord>; // This workspace's records
  focusItems: ExternalFocusItem[]; // sourceName "linear"; items for other workspaces are ignored
  // Tickets whose lack of unfinished items an earlier pass saw and a settle delay has passed
  confirmedRemovals: ReadonlySet<string>;
}

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/** The ticket key a Focus item links to, or null if its URL isn't a Linear ticket. */
export function itemTicketKey(item: ExternalFocusItem): string | null {
  const ref = parseTicketUrl(item.external.url);
  return ref ? ticketKey(ref) : null;
}

export function decideSyncActions(input: SyncInput): SyncAction[] {
  const { workspace, records, confirmedRemovals } = input;
  const labelName = input.labelName.toLowerCase();
  const keyFor = (identifier: string) =>
    ticketKey({ urlKey: workspace.urlKey, identifier: identifier.toUpperCase() });

  // A record follows its ticket by UUID, even if the ticket's identifier has changed
  const recordKeyByIssueId = new Map<string, string>();
  for (const [key, record] of Object.entries(records)) {
    recordKeyByIssueId.set(record.issueId, key);
  }
  const ticketsByKey = new Map<string, LinearTicket>();
  for (const ticket of [...input.trackedTickets, ...input.labelledTickets]) {
    ticketsByKey.set(recordKeyByIssueId.get(ticket.id) ?? keyFor(ticket.identifier), ticket);
  }

  const itemsByKey = new Map<string, ExternalFocusItem[]>();
  for (const item of input.focusItems) {
    const key = itemTicketKey(item);
    if (!key || !key.startsWith(`${workspace.urlKey}/`)) continue;
    itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item]);
  }

  const labelledKeys = new Set(
    input.labelledTickets.map((t) => recordKeyByIssueId.get(t.id) ?? keyFor(t.identifier))
  );
  const keys = new Set([...labelledKeys, ...Object.keys(records), ...itemsByKey.keys()]);

  const actions: SyncAction[] = [];
  for (const key of [...keys].sort()) {
    const record = records[key];
    const ticket = ticketsByKey.get(key);
    const unfinishedIds = (itemsByKey.get(key) ?? [])
      .filter((item) => item.completedAt === undefined)
      .map((item) => item.id);
    const labelled =
      labelledKeys.has(key) ||
      (ticket?.labelNames.some((name) => name.toLowerCase() === labelName) ?? false);

    // 1. Closed or deleted in Linear: finish its items, then let the label go
    if (!ticket || ticket.trashed || CLOSED_STATE_TYPES.has(ticket.stateType)) {
      if (unfinishedIds.length > 0) {
        actions.push({ type: "completeItems", ticketKey: key, itemIds: unfinishedIds });
      }
      if (record) {
        actions.push(
          ticket && !ticket.trashed && labelled
            ? { type: "removeLabel", ticketKey: key, issueId: record.issueId }
            : { type: "setRecord", ticketKey: key, record: null }
        );
      }
      continue;
    }

    // 2. Label added in Linear
    if (!record && labelled && unfinishedIds.length === 0) {
      actions.push({ type: "import", ticketKey: key, ticket });
      continue;
    }

    // 3. Label removed in Linear: "synced" means the plugin has seen it there
    if (record?.label === "synced" && !labelled) {
      actions.push({ type: "removeItems", ticketKey: key, itemIds: unfinishedIds });
      continue;
    }

    if (unfinishedIds.length > 0) {
      if (!labelled) {
        // 4. Label to add. No record means the item came from another device.
        actions.push({ type: "addLabel", ticketKey: key, issueId: record?.issueId ?? ticket.id });
      } else if (record?.label !== "synced" || record.issueId !== ticket.id) {
        // 6. Label present and wanted
        actions.push({
          type: "setRecord",
          ticketKey: key,
          record: { issueId: ticket.id, label: "synced" },
        });
      }
      continue;
    }

    // 5. Label to remove: no unfinished linked items
    if (!record) continue;
    if (!labelled) {
      actions.push({ type: "setRecord", ticketKey: key, record: null });
    } else if (record.label === "remove-pending" || confirmedRemovals.has(key)) {
      actions.push({ type: "removeLabel", ticketKey: key, issueId: record.issueId });
    } else {
      actions.push({ type: "awaitRemoval", ticketKey: key });
    }
  }
  return actions;
}
