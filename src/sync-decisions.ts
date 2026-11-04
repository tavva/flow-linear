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
  // What Focus shows might be a passing state: a sync glitch, or a device whose focus file is
  // behind. The label changes only once a later pass, after a settle delay, still sees it.
  | { type: "awaitRemoval"; ticketKey: string }
  | { type: "awaitAdd"; ticketKey: string }
  | { type: "setRecord"; ticketKey: string; record: TicketRecord | null };

export interface SyncInput {
  workspace: WorkspaceSettings;
  // The workspace-level label's id; null if the workspace doesn't have the label yet
  labelId: string | null;
  labelledTickets: LinearTicket[]; // Currently carry the label
  // Tickets asked for by UUID (records) and by identifier (linked items without a record).
  // A record whose ticket is missing here has been deleted.
  trackedTickets: LinearTicket[];
  records: Record<string, TicketRecord>; // This workspace's records
  focusItems: ExternalFocusItem[]; // sourceName "linear"; items for other workspaces are ignored
  // Ticket keys whose awaited change an earlier pass saw, at least a settle delay ago
  confirmedRemovals: ReadonlySet<string>;
  confirmedAdds: ReadonlySet<string>;
}

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/** The ticket key a Focus item links to, or null if its URL isn't a Linear ticket. */
export function itemTicketKey(item: ExternalFocusItem): string | null {
  const ref = parseTicketUrl(item.external.url);
  return ref ? ticketKey(ref) : null;
}

export function decideSyncActions(input: SyncInput): SyncAction[] {
  const { workspace, labelId, confirmedRemovals, confirmedAdds } = input;
  const keyFor = (identifier: string) =>
    ticketKey({ urlKey: workspace.urlKey, identifier: identifier.toUpperCase() });
  const actions: SyncAction[] = [];

  // One record per ticket: a ticket whose identifier changed may have gained a second record
  // under its new key. The first key in order is kept and the others are dropped.
  const recordKeyByIssueId = new Map<string, string>();
  const records: Record<string, TicketRecord> = {};
  for (const key of Object.keys(input.records).sort()) {
    const record = input.records[key];
    if (recordKeyByIssueId.has(record.issueId)) {
      actions.push({ type: "setRecord", ticketKey: key, record: null });
      continue;
    }
    recordKeyByIssueId.set(record.issueId, key);
    records[key] = record;
  }

  // Keys that name a tracked ticket by an identifier it no longer has, or had before
  const aliases = new Map<string, string>();
  for (const [key, record] of Object.entries(input.records)) {
    const canonical = recordKeyByIssueId.get(record.issueId) as string;
    if (key !== canonical) aliases.set(key, canonical);
  }
  for (const ticket of input.trackedTickets) {
    const recordKey = recordKeyByIssueId.get(ticket.id);
    if (recordKey && keyFor(ticket.identifier) !== recordKey) {
      aliases.set(keyFor(ticket.identifier), recordKey);
    }
  }
  const keyOfTicket = (ticket: LinearTicket) =>
    recordKeyByIssueId.get(ticket.id) ??
    aliases.get(keyFor(ticket.identifier)) ??
    keyFor(ticket.identifier);

  const ticketsByKey = new Map<string, LinearTicket>();
  for (const ticket of [...input.trackedTickets, ...input.labelledTickets]) {
    ticketsByKey.set(keyOfTicket(ticket), ticket);
  }
  const labelledKeys = new Set(input.labelledTickets.map(keyOfTicket));

  const itemsByKey = new Map<string, ExternalFocusItem[]>();
  for (const item of input.focusItems) {
    const itemKey = itemTicketKey(item);
    if (!itemKey || !itemKey.startsWith(`${workspace.urlKey}/`)) continue;
    const key = aliases.get(itemKey) ?? itemKey;
    itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item]);
  }

  const keys = new Set([...labelledKeys, ...Object.keys(records), ...itemsByKey.keys()]);
  for (const key of [...keys].sort()) {
    const record = records[key];
    const ticket = ticketsByKey.get(key);
    const unfinishedIds = (itemsByKey.get(key) ?? [])
      .filter((item) => item.completedAt === undefined)
      .map((item) => item.id);
    const labelled =
      labelledKeys.has(key) || (labelId !== null && (ticket?.labelIds.includes(labelId) ?? false));

    // A linked item for a ticket Linear didn't return, with no record: it may be in a team the
    // key can't see, or have moved. Leave it alone.
    if (!ticket && !record) continue;

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
        // 4. Label to add. With no record the item came from another device, whose focus file
        // may be ahead of or behind Linear, so wait for a later pass to confirm it.
        if (record || confirmedAdds.has(key)) {
          actions.push({ type: "addLabel", ticketKey: key, issueId: record?.issueId ?? ticket.id });
        } else {
          actions.push({ type: "awaitAdd", ticketKey: key });
        }
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
