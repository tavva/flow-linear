// ABOUTME: Decides, for one workspace, what a sync must do to Focus, Linear and the stored records.
// ABOUTME: Pure: takes the state of Linear, Focus and the records, and returns actions to carry out.

import { ExternalFocusItem } from "./flow-api";
import { LinearTicket } from "./linear-client";
import { TicketRecord, WorkspaceSettings } from "./settings";
import { parseTicketUrl, ticketKey } from "./ticket-url";

/**
 * Changes that rest on what this device's focus file shows, which may be behind other devices
 * or briefly wrong during a sync. Each is made only once a later pass, at least a settle delay
 * after the first, still calls for it.
 */
export type ConfirmedChange = "import" | "addLabel" | "removeLabel" | "removeItems";

export type SyncAction =
  | { type: "import"; ticketKey: string; ticket: LinearTicket } // Add a Focus item, record "synced"
  | { type: "removeItems"; ticketKey: string; itemIds: string[] } // And delete the record
  | { type: "completeItems"; ticketKey: string; itemIds: string[] }
  | { type: "addLabel"; ticketKey: string; issueId: string } // On success, record "synced"
  | { type: "removeLabel"; ticketKey: string; issueId: string } // On success, delete the record
  // Take a renamed-away label off (when labelId is set), then store `next` as the record
  | {
      type: "retireLabel";
      ticketKey: string;
      issueId: string;
      labelId: string | null;
      next: TicketRecord | null;
    }
  | { type: "await"; change: ConfirmedChange; ticketKey: string }
  | { type: "setRecord"; ticketKey: string; record: TicketRecord | null };

export interface SyncInput {
  workspace: WorkspaceSettings;
  labelName: string;
  // The workspace-level label's id; null if the workspace doesn't have the label yet
  labelId: string | null;
  // Ids of old label names that records still carry after a rename; null if Linear has none
  retiredLabelIds: ReadonlyMap<string, string | null>; // Keyed by lower-case name
  labelledTickets: LinearTicket[]; // Currently carry the label
  // Tickets asked for by UUID (records) and by identifier (linked items without a record).
  // A record whose ticket is missing here has been deleted.
  trackedTickets: LinearTicket[];
  // Tickets found by the identifier a linked item uses, which may be one they had before
  // moving team: ticket id → the ticket key that was looked up
  lookedUpAs: ReadonlyMap<string, string>;
  records: Record<string, TicketRecord>; // This workspace's records
  focusItems: ExternalFocusItem[]; // sourceName "linear"; items for other workspaces are ignored
  // Changes an earlier pass awaited at least a settle delay ago, as "<change>\n<ticket key>"
  confirmed: ReadonlySet<string>;
  // Tickets this device has itself seen with unfinished items. Only these may lose their
  // label because their items have gone: another device's file may simply be behind.
  seenUnfinished: ReadonlySet<string>;
}

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

export function confirmationKey(change: ConfirmedChange, ticketKey: string): string {
  return `${change}\n${ticketKey}`;
}

/** The ticket key a Focus item links to, or null if its URL isn't a Linear ticket. */
export function itemTicketKey(item: ExternalFocusItem): string | null {
  const ref = parseTicketUrl(item.external.url);
  return ref ? ticketKey(ref) : null;
}

export function decideSyncActions(input: SyncInput): SyncAction[] {
  const { workspace, labelId, confirmed, seenUnfinished } = input;
  const labelName = input.labelName.toLowerCase();
  const keyFor = (identifier: string) =>
    ticketKey({ urlKey: workspace.urlKey, identifier: identifier.toUpperCase() });
  const actions: SyncAction[] = [];
  const whenConfirmed = (change: ConfirmedChange, key: string, action: SyncAction) => {
    actions.push(
      confirmed.has(confirmationKey(change, key))
        ? action
        : { type: "await", change, ticketKey: key }
    );
  };

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
    input.lookedUpAs.get(ticket.id) ??
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
    // key can't see. Leave it alone.
    if (!ticket && !record) continue;

    // The label was renamed in settings: take the old one off first
    const recordLabel = record?.labelName?.toLowerCase();
    if (record && recordLabel !== undefined && recordLabel !== labelName) {
      const oldId = input.retiredLabelIds.get(recordLabel) ?? null;
      actions.push({
        type: "retireLabel",
        ticketKey: key,
        issueId: record.issueId,
        labelId: oldId !== null && ticket?.labelIds.includes(oldId) ? oldId : null,
        // A pending removal is done once the old label is off; anything else wants the new one
        next:
          record.label === "remove-pending"
            ? null
            : { issueId: record.issueId, label: "add-pending" },
      });
      continue;
    }

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

    // 2. Label added in Linear. Confirmed first: a device starting with an old focus file
    // might not yet show the item another device already made for it.
    if (!record && labelled && unfinishedIds.length === 0) {
      whenConfirmed("import", key, { type: "import", ticketKey: key, ticket });
      continue;
    }

    // 3. Label removed in Linear: "synced" means the plugin has seen it there. Rechecked on a
    // later pass before the items go, in case another device removed it in error.
    if (record?.label === "synced" && !labelled) {
      if (unfinishedIds.length === 0) {
        actions.push({ type: "setRecord", ticketKey: key, record: null });
      } else {
        whenConfirmed("removeItems", key, {
          type: "removeItems",
          ticketKey: key,
          itemIds: unfinishedIds,
        });
      }
      continue;
    }

    if (unfinishedIds.length > 0) {
      if (!labelled) {
        // 4. Label to add. With no record the item came from another device, whose focus file
        // may be ahead of or behind Linear, so it's confirmed first.
        const addLabel: SyncAction = {
          type: "addLabel",
          ticketKey: key,
          issueId: record?.issueId ?? ticket.id,
        };
        if (record) actions.push(addLabel);
        else whenConfirmed("addLabel", key, addLabel);
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
    } else if (record.label === "remove-pending") {
      actions.push({ type: "removeLabel", ticketKey: key, issueId: record.issueId });
    } else if (seenUnfinished.has(key)) {
      whenConfirmed("removeLabel", key, {
        type: "removeLabel",
        ticketKey: key,
        issueId: record.issueId,
      });
    }
    // Otherwise this device never saw the items, so it leaves the label to the device that did
  }
  return actions;
}
