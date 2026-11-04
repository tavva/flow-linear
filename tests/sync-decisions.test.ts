// ABOUTME: Table-driven tests for decideSyncActions, one group per sync rule.
// ABOUTME: Also covers deleted tickets, several items per ticket and clashing identifiers.

import { decideSyncActions, itemTicketKey, SyncInput } from "../src/sync-decisions";
import { TicketRecord } from "../src/settings";
import { focusItem, labelled, ticket, workspace } from "./helpers/builders";

function decide(overrides: Partial<SyncInput>) {
  return decideSyncActions({
    workspace: workspace(),
    labelName: "flow-focus",
    labelledTickets: [],
    trackedTickets: [],
    records: {},
    focusItems: [],
    confirmedRemovals: new Set(),
    ...overrides,
  });
}

const synced = (identifier: string): TicketRecord => ({
  issueId: `uuid-testco-${identifier}`,
  label: "synced",
});
const pending = (identifier: string, label: TicketRecord["label"]): TicketRecord => ({
  issueId: `uuid-testco-${identifier}`,
  label,
});

describe("rule 1: closed in Linear", () => {
  it.each(["completed", "canceled"])(
    "completes unfinished items and removes the label (%s)",
    (stateType) => {
      const done = focusItem("TST-1", { completedAt: 5 });
      const open = focusItem("TST-1");
      const closed = labelled("TST-1", { stateType });
      expect(
        decide({
          labelledTickets: [closed],
          trackedTickets: [closed],
          records: { "testco/TST-1": synced("TST-1") },
          focusItems: [done, open],
        })
      ).toEqual([
        { type: "completeItems", ticketKey: "testco/TST-1", itemIds: [open.id] },
        { type: "removeLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" },
      ]);
    }
  );

  it("deletes the record without a label change when the label is already gone", () => {
    const item = focusItem("TST-1");
    expect(
      decide({
        trackedTickets: [ticket("TST-1", { stateType: "completed" })],
        records: { "testco/TST-1": synced("TST-1") },
        focusItems: [item],
      })
    ).toEqual([
      { type: "completeItems", ticketKey: "testco/TST-1", itemIds: [item.id] },
      { type: "setRecord", ticketKey: "testco/TST-1", record: null },
    ]);
  });

  it("doesn't import a closed ticket that carries the label", () => {
    expect(decide({ labelledTickets: [labelled("TST-1", { stateType: "completed" })] })).toEqual(
      []
    );
  });
});

describe("deleted in Linear", () => {
  it("treats a tracked ticket that comes back missing as closed", () => {
    const item = focusItem("TST-1");
    expect(decide({ records: { "testco/TST-1": synced("TST-1") }, focusItems: [item] })).toEqual([
      { type: "completeItems", ticketKey: "testco/TST-1", itemIds: [item.id] },
      { type: "setRecord", ticketKey: "testco/TST-1", record: null },
    ]);
  });

  it("treats a trashed ticket as deleted", () => {
    const trashed = labelled("TST-1", { trashed: true });
    expect(
      decide({
        labelledTickets: [trashed],
        trackedTickets: [trashed],
        records: { "testco/TST-1": synced("TST-1") },
      })
    ).toEqual([{ type: "setRecord", ticketKey: "testco/TST-1", record: null }]);
  });

  it("completes items of an untracked ticket that Linear doesn't have", () => {
    const item = focusItem("TST-9");
    expect(decide({ focusItems: [item] })).toEqual([
      { type: "completeItems", ticketKey: "testco/TST-9", itemIds: [item.id] },
    ]);
  });
});

describe("rule 2: label added in Linear", () => {
  it("imports a labelled ticket with no record and no items", () => {
    const t = labelled("TST-1");
    expect(decide({ labelledTickets: [t] })).toEqual([
      { type: "import", ticketKey: "testco/TST-1", ticket: t },
    ]);
  });

  it("matches the label name case-insensitively via the labelled query", () => {
    const t = ticket("TST-1", { labelNames: ["Flow-Focus"] });
    expect(decide({ labelledTickets: [t] })).toEqual([
      { type: "import", ticketKey: "testco/TST-1", ticket: t },
    ]);
  });

  it("imports again when the ticket's only linked items are completed", () => {
    const t = labelled("TST-1");
    expect(
      decide({ labelledTickets: [t], focusItems: [focusItem("TST-1", { completedAt: 9 })] })
    ).toEqual([{ type: "import", ticketKey: "testco/TST-1", ticket: t }]);
  });
});

describe("rule 3: label removed in Linear", () => {
  it("removes unfinished items, keeps completed ones and deletes the record", () => {
    const open = focusItem("TST-1");
    const done = focusItem("TST-1", { completedAt: 3 });
    expect(
      decide({
        trackedTickets: [ticket("TST-1")],
        records: { "testco/TST-1": synced("TST-1") },
        focusItems: [open, done],
      })
    ).toEqual([{ type: "removeItems", ticketKey: "testco/TST-1", itemIds: [open.id] }]);
  });

  it("deletes the record when there are no unfinished items", () => {
    expect(
      decide({ trackedTickets: [ticket("TST-1")], records: { "testco/TST-1": synced("TST-1") } })
    ).toEqual([{ type: "removeItems", ticketKey: "testco/TST-1", itemIds: [] }]);
  });
});

describe("rule 4: label to add", () => {
  it("adds the label for a pending add", () => {
    expect(
      decide({
        trackedTickets: [ticket("TST-1")],
        records: { "testco/TST-1": pending("TST-1", "add-pending") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([{ type: "addLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" }]);
  });

  it("adds the label when the item came from another device and there's no record", () => {
    expect(decide({ trackedTickets: [ticket("TST-1")], focusItems: [focusItem("TST-1")] })).toEqual(
      [{ type: "addLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" }]
    );
  });

  it("adds the label back when an item returns while a removal is pending", () => {
    expect(
      decide({
        trackedTickets: [ticket("TST-1")],
        records: { "testco/TST-1": pending("TST-1", "remove-pending") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([{ type: "addLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" }]);
  });
});

describe("rule 5: label to remove", () => {
  const records = { "testco/TST-1": synced("TST-1") };
  const t = labelled("TST-1");

  it("waits for confirmation before removing the label", () => {
    expect(decide({ labelledTickets: [t], trackedTickets: [t], records })).toEqual([
      { type: "awaitRemoval", ticketKey: "testco/TST-1" },
    ]);
  });

  it("waits when the only linked items are completed", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records,
        focusItems: [focusItem("TST-1", { completedAt: 2 })],
      })
    ).toEqual([{ type: "awaitRemoval", ticketKey: "testco/TST-1" }]);
  });

  it("removes the label once confirmed", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records,
        confirmedRemovals: new Set(["testco/TST-1"]),
      })
    ).toEqual([{ type: "removeLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" }]);
  });

  it("retries a pending removal without waiting again", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { "testco/TST-1": pending("TST-1", "remove-pending") },
      })
    ).toEqual([{ type: "removeLabel", ticketKey: "testco/TST-1", issueId: "uuid-testco-TST-1" }]);
  });

  it.each(["add-pending", "remove-pending"] as const)(
    "deletes a %s record when the label is already gone",
    (label) => {
      expect(
        decide({
          trackedTickets: [ticket("TST-1")],
          records: { "testco/TST-1": pending("TST-1", label) },
        })
      ).toEqual([{ type: "setRecord", ticketKey: "testco/TST-1", record: null }]);
    }
  );
});

describe("rule 6: label present and wanted", () => {
  const t = labelled("TST-1");

  it("marks the record synced", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { "testco/TST-1": pending("TST-1", "add-pending") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([
      {
        type: "setRecord",
        ticketKey: "testco/TST-1",
        record: { issueId: "uuid-testco-TST-1", label: "synced" },
      },
    ]);
  });

  it("records a labelled ticket added from another device", () => {
    expect(
      decide({ labelledTickets: [t], trackedTickets: [t], focusItems: [focusItem("TST-1")] })
    ).toEqual([
      {
        type: "setRecord",
        ticketKey: "testco/TST-1",
        record: { issueId: "uuid-testco-TST-1", label: "synced" },
      },
    ]);
  });

  it("does nothing once synced, so its own change events lead nowhere", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { "testco/TST-1": synced("TST-1") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([]);
  });
});

describe("several items for one ticket", () => {
  it("keeps the label while one unfinished item remains", () => {
    const t = labelled("TST-1");
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { "testco/TST-1": synced("TST-1") },
        focusItems: [focusItem("TST-1", { completedAt: 4 }), focusItem("TST-1")],
      })
    ).toEqual([]);
  });
});

describe("workspaces", () => {
  it("ignores items and records for other workspaces, even with the same identifier", () => {
    const other = focusItem("TST-1", { urlKey: "otherco" });
    expect(
      decide({
        workspace: workspace("testco"),
        focusItems: [other],
        records: {},
        labelledTickets: [],
      })
    ).toEqual([]);

    const ours = labelled("TST-1");
    expect(decide({ labelledTickets: [ours], focusItems: [other] })).toEqual([
      { type: "import", ticketKey: "testco/TST-1", ticket: ours },
    ]);
  });

  it("ignores items whose URL isn't a Linear ticket", () => {
    const item = focusItem("TST-1");
    item.external.url = "https://example.com/TST-1";
    expect(decide({ focusItems: [item] })).toEqual([]);
    expect(itemTicketKey(item)).toBeNull();
  });
});

describe("identifier changes", () => {
  it("follows a tracked ticket by UUID when it moves team", () => {
    const moved = labelled("NEW-7", { id: "uuid-testco-TST-1" });
    expect(
      decide({
        labelledTickets: [moved],
        trackedTickets: [moved],
        records: { "testco/TST-1": synced("TST-1") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([]);
  });
});
