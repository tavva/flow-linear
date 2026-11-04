// ABOUTME: Table-driven tests for decideSyncActions, one group per sync rule.
// ABOUTME: Also covers confirmation, label renames, deleted and moved tickets, and workspaces.

import {
  ConfirmedChange,
  confirmationKey,
  decideSyncActions,
  itemTicketKey,
  SyncInput,
} from "../src/sync-decisions";
import { TicketRecord } from "../src/settings";
import { FOCUS_LABEL_ID, focusItem, labelled, ticket, workspace } from "./helpers/builders";

const KEY = "testco/TST-1";

function decide(overrides: Partial<SyncInput>) {
  return decideSyncActions({
    workspace: workspace(),
    labelName: "flow-focus",
    labelId: FOCUS_LABEL_ID,
    retiredLabelIds: new Map(),
    labelledTickets: [],
    trackedTickets: [],
    lookedUpAs: new Map(),
    records: {},
    focusItems: [],
    confirmed: new Set(),
    seenUnfinished: new Set(),
    ...overrides,
  });
}

function confirmedFor(change: ConfirmedChange, key = KEY) {
  return new Set([confirmationKey(change, key)]);
}

const awaiting = (change: ConfirmedChange, ticketKey = KEY) => ({
  type: "await",
  change,
  ticketKey,
});

const synced = (identifier = "TST-1"): TicketRecord => ({
  issueId: `uuid-testco-${identifier}`,
  label: "synced",
});
const pending = (label: TicketRecord["label"], identifier = "TST-1"): TicketRecord => ({
  issueId: `uuid-testco-${identifier}`,
  label,
});

describe("rule 1: closed in Linear", () => {
  it.each(["completed", "canceled"])(
    "completes unfinished items and removes the label at once (%s)",
    (stateType) => {
      const done = focusItem("TST-1", { completedAt: 5 });
      const open = focusItem("TST-1");
      const closed = labelled("TST-1", { stateType });
      expect(
        decide({
          labelledTickets: [closed],
          trackedTickets: [closed],
          records: { [KEY]: synced() },
          focusItems: [done, open],
        })
      ).toEqual([
        { type: "completeItems", ticketKey: KEY, itemIds: [open.id] },
        { type: "removeLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" },
      ]);
    }
  );

  it("deletes the record without a label change when the label is already gone", () => {
    const item = focusItem("TST-1");
    expect(
      decide({
        trackedTickets: [ticket("TST-1", { stateType: "completed" })],
        records: { [KEY]: synced() },
        focusItems: [item],
      })
    ).toEqual([
      { type: "completeItems", ticketKey: KEY, itemIds: [item.id] },
      { type: "setRecord", ticketKey: KEY, record: null },
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
    expect(decide({ records: { [KEY]: synced() }, focusItems: [item] })).toEqual([
      { type: "completeItems", ticketKey: KEY, itemIds: [item.id] },
      { type: "setRecord", ticketKey: KEY, record: null },
    ]);
  });

  it("treats a trashed ticket as deleted", () => {
    const trashed = labelled("TST-1", { trashed: true });
    expect(
      decide({
        labelledTickets: [trashed],
        trackedTickets: [trashed],
        records: { [KEY]: synced() },
      })
    ).toEqual([{ type: "setRecord", ticketKey: KEY, record: null }]);
  });

  it("leaves alone items of an untracked ticket that Linear didn't return", () => {
    // It may be in a team the key can't see
    expect(decide({ focusItems: [focusItem("TST-9")] })).toEqual([]);
  });
});

describe("rule 2: label added in Linear", () => {
  const t = labelled("TST-1");

  it("waits for a later pass, then imports", () => {
    expect(decide({ labelledTickets: [t] })).toEqual([awaiting("import")]);
    expect(decide({ labelledTickets: [t], confirmed: confirmedFor("import") })).toEqual([
      { type: "import", ticketKey: KEY, ticket: t },
    ]);
  });

  it("imports again when the ticket's only linked items are completed", () => {
    expect(
      decide({
        labelledTickets: [t],
        focusItems: [focusItem("TST-1", { completedAt: 9 })],
        confirmed: confirmedFor("import"),
      })
    ).toEqual([{ type: "import", ticketKey: KEY, ticket: t }]);
  });

  it("counts a ticket as labelled only by the workspace label's id", () => {
    // A team label of the same name has another id
    const teamLabelled = ticket("TST-1", { labelIds: ["team-label"] });
    expect(decide({ trackedTickets: [teamLabelled], records: { [KEY]: synced() } })).toEqual([
      { type: "setRecord", ticketKey: KEY, record: null },
    ]);
  });
});

describe("rule 3: label removed in Linear", () => {
  const open = focusItem("TST-1");
  const done = focusItem("TST-1", { completedAt: 3 });
  const input = {
    trackedTickets: [ticket("TST-1")],
    records: { [KEY]: synced() },
    focusItems: [open, done],
  };

  it("rechecks on a later pass, then removes unfinished items and keeps completed ones", () => {
    expect(decide(input)).toEqual([awaiting("removeItems")]);
    expect(decide({ ...input, confirmed: confirmedFor("removeItems") })).toEqual([
      { type: "removeItems", ticketKey: KEY, itemIds: [open.id] },
    ]);
  });

  it("just deletes the record when there are no unfinished items", () => {
    expect(decide({ trackedTickets: [ticket("TST-1")], records: { [KEY]: synced() } })).toEqual([
      { type: "setRecord", ticketKey: KEY, record: null },
    ]);
  });
});

describe("rule 4: label to add", () => {
  it.each(["add-pending", "remove-pending"] as const)(
    "adds the label at once for a %s record with unfinished items",
    (label) => {
      expect(
        decide({
          trackedTickets: [ticket("TST-1")],
          records: { [KEY]: pending(label) },
          focusItems: [focusItem("TST-1")],
        })
      ).toEqual([{ type: "addLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" }]);
    }
  );

  it("waits before adding the label for an item from another device with no record", () => {
    const input = { trackedTickets: [ticket("TST-1")], focusItems: [focusItem("TST-1")] };
    expect(decide(input)).toEqual([awaiting("addLabel")]);
    expect(decide({ ...input, confirmed: confirmedFor("addLabel") })).toEqual([
      { type: "addLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" },
    ]);
  });

  it("adds the label when the workspace doesn't have it yet", () => {
    expect(
      decide({
        labelId: null,
        trackedTickets: [ticket("TST-1", { labelIds: [] })],
        records: { [KEY]: pending("add-pending") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([{ type: "addLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" }]);
  });
});

describe("rule 5: label to remove", () => {
  const t = labelled("TST-1");
  const base = { labelledTickets: [t], trackedTickets: [t], records: { [KEY]: synced() } };

  it("waits for confirmation when this device saw the items", () => {
    expect(decide({ ...base, seenUnfinished: new Set([KEY]) })).toEqual([awaiting("removeLabel")]);
  });

  it("removes the label once confirmed", () => {
    expect(
      decide({
        ...base,
        seenUnfinished: new Set([KEY]),
        confirmed: confirmedFor("removeLabel"),
      })
    ).toEqual([{ type: "removeLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" }]);
  });

  it("leaves the label alone when this device never saw the items unfinished", () => {
    // Another device added them; this device's focus file may simply be behind
    expect(decide({ ...base, confirmed: confirmedFor("removeLabel") })).toEqual([]);
  });

  it("waits when the only linked items are completed", () => {
    expect(
      decide({
        ...base,
        focusItems: [focusItem("TST-1", { completedAt: 2 })],
        seenUnfinished: new Set([KEY]),
      })
    ).toEqual([awaiting("removeLabel")]);
  });

  it("retries a pending removal without waiting again", () => {
    expect(decide({ ...base, records: { [KEY]: pending("remove-pending") } })).toEqual([
      { type: "removeLabel", ticketKey: KEY, issueId: "uuid-testco-TST-1" },
    ]);
  });

  it.each(["add-pending", "remove-pending"] as const)(
    "deletes a %s record when the label is already gone",
    (label) => {
      expect(
        decide({ trackedTickets: [ticket("TST-1")], records: { [KEY]: pending(label) } })
      ).toEqual([{ type: "setRecord", ticketKey: KEY, record: null }]);
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
        records: { [KEY]: pending("add-pending") },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([
      {
        type: "setRecord",
        ticketKey: KEY,
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
        ticketKey: KEY,
        record: { issueId: "uuid-testco-TST-1", label: "synced" },
      },
    ]);
  });

  it("does nothing once synced, so its own change events lead nowhere", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { [KEY]: synced() },
        focusItems: [focusItem("TST-1")],
        seenUnfinished: new Set([KEY]),
      })
    ).toEqual([]);
  });

  it("keeps the label while one of several items is unfinished", () => {
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { [KEY]: synced() },
        focusItems: [focusItem("TST-1", { completedAt: 4 }), focusItem("TST-1")],
        seenUnfinished: new Set([KEY]),
      })
    ).toEqual([]);
  });
});

describe("label renamed in settings", () => {
  const retiredLabelIds = new Map([["old-focus", "label-old"]]);

  it("takes the old label off, then wants the new one", () => {
    expect(
      decide({
        retiredLabelIds,
        trackedTickets: [ticket("TST-1", { labelIds: ["label-old"] })],
        records: { [KEY]: { ...synced(), labelName: "old-focus" } },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([
      {
        type: "retireLabel",
        ticketKey: KEY,
        issueId: "uuid-testco-TST-1",
        labelId: "label-old",
        next: { issueId: "uuid-testco-TST-1", label: "add-pending" },
      },
    ]);
  });

  it("finishes a pending removal of the old label and forgets the ticket", () => {
    expect(
      decide({
        retiredLabelIds,
        trackedTickets: [ticket("TST-1", { labelIds: ["label-old"] })],
        records: { [KEY]: { ...pending("remove-pending"), labelName: "old-focus" } },
      })
    ).toEqual([
      {
        type: "retireLabel",
        ticketKey: KEY,
        issueId: "uuid-testco-TST-1",
        labelId: "label-old",
        next: null,
      },
    ]);
  });

  it("skips the removal when the old label is gone or not on the ticket", () => {
    const actions = decide({
      retiredLabelIds: new Map([["old-focus", null]]),
      trackedTickets: [ticket("TST-1")],
      records: { [KEY]: { ...synced(), labelName: "old-focus" } },
    });
    expect(actions).toEqual([expect.objectContaining({ type: "retireLabel", labelId: null })]);
  });

  it("treats a record naming the current label as current", () => {
    const t = labelled("TST-1");
    expect(
      decide({
        labelledTickets: [t],
        trackedTickets: [t],
        records: { [KEY]: { ...synced(), labelName: "Flow-Focus" } },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([]);
  });
});

describe("workspaces", () => {
  it("ignores items and records for other workspaces, even with the same identifier", () => {
    const other = focusItem("TST-1", { urlKey: "otherco" });
    expect(decide({ focusItems: [other] })).toEqual([]);
    expect(decide({ labelledTickets: [labelled("TST-1")], focusItems: [other] })).toEqual([
      awaiting("import"),
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
  const moved = labelled("NEW-7", { id: "uuid-testco-TST-1" });

  it("follows a tracked ticket by UUID when it moves team", () => {
    expect(
      decide({
        labelledTickets: [moved],
        trackedTickets: [moved],
        records: { [KEY]: synced() },
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([]);
  });

  it("counts items linked by the new identifier towards the tracked ticket", () => {
    expect(
      decide({
        labelledTickets: [moved],
        trackedTickets: [moved],
        records: { [KEY]: synced() },
        focusItems: [focusItem("NEW-7")],
      })
    ).toEqual([]);
  });

  it("keys an untracked ticket by the identifier its item was looked up with", () => {
    const found = ticket("NEW-7", { id: "uuid-moved" });
    expect(
      decide({
        trackedTickets: [found],
        lookedUpAs: new Map([["uuid-moved", KEY]]),
        focusItems: [focusItem("TST-1")],
      })
    ).toEqual([awaiting("addLabel")]);
  });

  it("merges two records for one ticket, keeping the first key", () => {
    expect(
      decide({
        labelledTickets: [moved],
        trackedTickets: [moved],
        records: { [KEY]: synced(), "testco/NEW-7": pending("add-pending") },
        focusItems: [focusItem("TST-1", { completedAt: 1 }), focusItem("NEW-7")],
      })
    ).toEqual([
      // "testco/NEW-7" sorts first, so it stays; the other record goes
      { type: "setRecord", ticketKey: KEY, record: null },
      {
        type: "setRecord",
        ticketKey: "testco/NEW-7",
        record: { issueId: "uuid-testco-TST-1", label: "synced" },
      },
    ]);
  });
});
