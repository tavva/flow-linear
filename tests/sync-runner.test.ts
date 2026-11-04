// ABOUTME: Tests the sync runner against an in-memory Focus list and Linear workspace.
// ABOUTME: Covers carrying out each action, confirmation, failures, renames and run queuing.

import { NO_KEY_STATUS } from "../src/sync-runner";
import { focusItem, labelled, ticket, workspace } from "./helpers/builders";
import { CONFIRM_MS, Harness } from "./helpers/harness";
import { LinearWorkspace } from "./helpers/linear-workspace";

const KEY = "testco/TST-1";
const record = (label: "synced" | "add-pending" | "remove-pending", identifier = "TST-1") => ({
  issueId: `uuid-testco-${identifier}`,
  label,
});

function quietConsole() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("importing a ticket labelled in Linear", () => {
  it("waits for a later pass, then adds a Focus item and records the ticket as synced", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1", { title: "Write the plan" })];

    await h.sync();
    expect(h.focus.items).toEqual([]);
    await h.passTime(CONFIRM_MS);

    expect(h.focus.items).toHaveLength(1);
    expect(h.focus.items[0]).toMatchObject({
      text: "Write the plan",
      sphere: "work",
      external: {
        sourceName: "linear",
        sourceLabel: "Testco",
        url: "https://linear.app/testco/issue/TST-1/some-title",
        externalId: "TST-1",
      },
    });
    expect(h.data.tickets).toEqual({ [KEY]: record("synced") });
    expect(h.local).toEqual([KEY]);
    expect(h.runner.getStatus("testco")).toEqual({ lastSuccessAt: h.clock.now });
  });

  it("does nothing more on the next sync, so its own change events are harmless", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1")];
    let events = 0;
    h.focus.onFocusChange("linear", () => events++);

    await h.settle();
    expect(events).toBe(1);
    const writes = [...h.focus.writes];
    const saves = h.saves;

    await h.sync();
    expect(h.focus.writes).toEqual(writes);
    expect(h.testco.writes).toEqual([]);
    expect(h.saves).toBe(saves);
  });

  it("uses Flow's first sphere when the workspace has no default", async () => {
    const h = new Harness([workspace("testco", { defaultSphere: "" })]);
    h.testco.tickets = [labelled("TST-1")];
    await h.settle();
    expect(h.focus.items[0].sphere).toBe("personal");
  });

  it("reports an error and keeps no record when there's no sphere at all", async () => {
    const h = new Harness([workspace("testco", { defaultSphere: "" })]);
    h.focus.spheres = [];
    h.testco.tickets = [labelled("TST-1")];
    const consoleError = quietConsole();

    await h.settle();

    expect(h.focus.items).toEqual([]);
    expect(h.data.tickets).toEqual({});
    expect(h.runner.getStatus("testco").error).toMatch(/No sphere/);
    expect(h.notices).toEqual([
      "Flow Linear couldn't sync Testco: No sphere to add Linear tickets to; set one in settings",
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      "Flow Linear sync failed for Testco",
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it("doesn't add a second item when another device imported it meanwhile", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1")];
    await h.sync();
    const realGet = h.focus.getFocusItems.bind(h.focus);
    let reads = 0;
    // The confirming pass's second read is the import's re-check; another device's item is there
    h.focus.getFocusItems = async (source) => {
      if (++reads === 2) h.focus.items.push(focusItem("TST-1"));
      return realGet(source);
    };

    await h.passTime(CONFIRM_MS);

    expect(h.focus.items).toHaveLength(1);
    expect(h.focus.writes).toEqual([]);
    expect(h.data.tickets[KEY].label).toBe("synced");
  });
});

describe("adding the label for items added here", () => {
  it("creates the workspace label once, adds it and marks the records synced", async () => {
    const h = new Harness();
    h.testco.labels.clear();
    h.testco.tickets = [ticket("TST-1"), ticket("TST-2")];
    h.focus.items = [focusItem("TST-1"), focusItem("TST-2")];
    h.data.tickets[KEY] = record("add-pending");
    h.data.tickets["testco/TST-2"] = record("add-pending", "TST-2");

    await h.sync();

    expect(h.testco.writes).toEqual([
      "create label flow-focus",
      "add label TST-1",
      "add label TST-2",
    ]);
    expect(h.data.tickets[KEY]).toEqual(record("synced"));
  });

  it("uses an existing workspace label", async () => {
    const h = new Harness();
    h.testco.labels.set("flow-focus", "label-existing");
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");
    await h.sync();
    expect(h.testco.writes).toEqual(["add label TST-1"]);
    expect(h.testco.tickets[0].labelIds).toEqual(["label-existing"]);
  });

  it("leaves the record unchanged when adding the label fails, and retries next time", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");
    h.testco.failNext("addLabel", "network");

    await h.sync();
    expect(h.data.tickets[KEY].label).toBe("add-pending");
    expect(h.runner.getStatus("testco").error).toBe("addLabel failed (network)");
    expect(h.notices).toEqual(["Couldn't reach Linear for Testco"]);

    await h.sync();
    expect(h.data.tickets[KEY].label).toBe("synced");
    expect(h.runner.getStatus("testco")).toEqual({ lastSuccessAt: h.clock.now });
  });
});

describe("items added on another device", () => {
  it("adds the label only once a later pass still finds the item", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];

    await h.sync();
    expect(h.testco.writes).toEqual([]);
    await h.passTime(CONFIRM_MS);
    expect(h.testco.writes).toEqual(["add label TST-1"]);
    expect(h.data.tickets[KEY].label).toBe("synced");
  });

  it("doesn't add the label back for an item another device has since removed", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];

    await h.sync();
    h.focus.replaceAll([]);
    await h.passTime(CONFIRM_MS);

    expect(h.testco.writes).toEqual([]);
    expect(h.data.tickets).toEqual({});
  });

  it("finds a ticket linked by an identifier it had before moving team", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("NEW-7", { id: "uuid-moved" })];
    h.testco.oldIdentifiers.set("TST-1", "uuid-moved");
    h.focus.items = [focusItem("TST-1")];

    await h.settle();

    expect(h.testco.writes).toEqual(["add label NEW-7"]);
    expect(h.focus.items[0].completedAt).toBeUndefined();
  });
});

describe("the workspace label", () => {
  it("pauses the workspace when the label is a team label, and says so", async () => {
    const h = new Harness();
    h.testco.labels.clear();
    h.testco.teamLabels.add("flow-focus");
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");

    await h.sync();

    expect(h.testco.writes).toEqual([]);
    expect(h.notices).toEqual([
      '"flow-focus" is a team label in Testco. Flow Linear needs a workspace label: rename the team label, or choose another label name in settings.',
    ]);
    expect(h.runner.getStatus("testco").error).toMatch(/team label/);
  });

  it("pauses rather than read a missing label as every label removed", async () => {
    const h = new Harness();
    h.testco.labels.clear();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");

    await h.settle();

    expect(h.focus.items).toHaveLength(1);
    expect(h.focus.items[0].completedAt).toBeUndefined();
    expect(h.data.tickets[KEY]).toEqual(record("synced"));
    expect(h.notices[0]).toMatch(/^The label "flow-focus" is missing from Testco/);
  });
});

describe("removing the label", () => {
  function syncedTicket(h: Harness) {
    h.testco.tickets = [labelled("TST-1")];
    h.data.tickets[KEY] = record("synced");
  }

  it("removes the label when items this device saw have gone and a later pass agrees", async () => {
    const h = new Harness();
    syncedTicket(h);
    const item = focusItem("TST-1");
    h.focus.items = [item];
    await h.sync();
    expect(h.local).toEqual([KEY]);

    await h.focus.completeFocusItem(item.id);
    await h.sync();
    expect(h.testco.writes).toEqual([]);
    expect(h.scheduled).toEqual([{ callback: expect.any(Function), delayMs: CONFIRM_MS }]);

    // A sync soon afterwards, before the delay is up, still waits
    h.clock.now += 1000;
    await h.sync();
    expect(h.testco.writes).toEqual([]);

    await h.passTime(CONFIRM_MS);
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
    expect(h.local).toEqual([]);
  });

  it("schedules one follow-up however many passes wait", async () => {
    const h = new Harness();
    syncedTicket(h);
    h.local = [KEY];
    h.restart();
    await h.sync();
    await h.sync();
    await h.sync();
    expect(h.scheduled).toHaveLength(1);

    h.clock.now += CONFIRM_MS;
    const run = jest.spyOn(h.runner, "requestSync");
    h.scheduled[0].callback();
    await run.mock.results[0].value;
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
  });

  it("keeps the label when the items come back, as after a sync glitch", async () => {
    const h = new Harness();
    syncedTicket(h);
    const item = focusItem("TST-1");
    h.focus.items = [item];
    await h.sync();

    h.focus.replaceAll([]);
    await h.sync();
    h.focus.replaceAll([item]);
    await h.passTime(CONFIRM_MS);
    // Gone again: the earlier sighting no longer counts
    h.focus.replaceAll([]);
    await h.sync();

    expect(h.testco.writes).toEqual([]);
    expect(h.data.tickets[KEY].label).toBe("synced");
  });

  it("retries a failed removal on the next pass without waiting again", async () => {
    const h = new Harness();
    syncedTicket(h);
    h.local = [KEY];
    h.restart();
    await h.sync();
    h.testco.failNext("removeLabel", "network");
    await h.passTime(CONFIRM_MS);
    expect(h.data.tickets[KEY].label).toBe("remove-pending");

    await h.sync();
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
  });
});

describe("changes made in Linear", () => {
  it("removes unfinished items when a later pass agrees the label was removed", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    const open = focusItem("TST-1");
    const done = focusItem("TST-1", { completedAt: 3 });
    h.focus.items = [open, done];
    h.data.tickets[KEY] = record("synced");

    await h.sync();
    expect(h.focus.items).toHaveLength(2);
    await h.passTime(CONFIRM_MS);

    expect(h.focus.items.map((i) => i.id)).toEqual([done.id]);
    expect(h.data.tickets).toEqual({});
  });

  it("keeps the items when the label is back by the later pass", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");

    await h.sync();
    h.testco.tickets[0].labelIds = ["label-1"];
    await h.passTime(CONFIRM_MS);

    expect(h.focus.items).toHaveLength(1);
    expect(h.data.tickets[KEY]).toEqual(record("synced"));
  });

  it("completes items for a closed ticket and removes its label", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1", { stateType: "completed" })];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");

    await h.sync();

    expect(h.focus.items[0].completedAt).toBeDefined();
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
  });

  it("completes items for a deleted ticket and forgets it", async () => {
    const h = new Harness();
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");

    await h.sync();

    expect(h.focus.items[0].completedAt).toBeDefined();
    expect(h.data.tickets).toEqual({});
  });

  it("treats an item that has already gone as removed", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");
    await h.sync();
    const remove = h.focus.removeFocusItem.bind(h.focus);
    h.focus.removeFocusItem = async (id) => {
      h.focus.items = [];
      return remove(id);
    };

    await h.passTime(CONFIRM_MS);

    expect(h.data.tickets).toEqual({});
    expect(h.runner.getStatus("testco").error).toBeUndefined();
  });

  it("keeps the record when a Focus write fails for an item that's still there", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");
    await h.sync();
    h.focus.removeFocusItem = async () => {
      throw new Error("Focus file is locked");
    };
    const consoleError = quietConsole();

    await h.passTime(CONFIRM_MS);

    expect(h.data.tickets[KEY].label).toBe("synced");
    expect(h.runner.getStatus("testco").error).toBe("Focus file is locked");
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("keeps an item completed on another device since the pass read Focus", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");
    await h.sync();
    const realGet = h.focus.getFocusItems.bind(h.focus);
    let reads = 0;
    h.focus.getFocusItems = async (source) => {
      if (++reads === 2) h.focus.items[0].completedAt = 7;
      return realGet(source);
    };

    await h.passTime(CONFIRM_MS);

    expect(h.focus.items).toHaveLength(1);
    expect(h.data.tickets).toEqual({});
  });
});

describe("a failing action", () => {
  it("doesn't hold up the other actions, and is reported", async () => {
    const h = new Harness([workspace("testco", { defaultSphere: "" })]);
    h.testco.tickets = [labelled("TST-1"), labelled("TST-2", { stateType: "completed" })];
    h.focus.items = [focusItem("TST-2")];
    h.data.tickets["testco/TST-2"] = record("synced", "TST-2");
    // TST-1's import fails; TST-2, sorted after it, must still be handled
    h.focus.spheres = [];
    const consoleError = quietConsole();

    await h.settle();

    expect(h.focus.items[0].completedAt).toBeDefined();
    expect(h.testco.writes).toEqual(["remove label TST-2"]);
    expect(h.runner.getStatus("testco").error).toMatch(/No sphere/);
    consoleError.mockRestore();
  });

  it("stops the workspace when Linear can't be reached", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1"), ticket("TST-2")];
    h.focus.items = [focusItem("TST-1"), focusItem("TST-2")];
    h.data.tickets[KEY] = record("add-pending");
    h.data.tickets["testco/TST-2"] = record("add-pending", "TST-2");
    h.testco.failNext("addLabel", "network");

    await h.sync();

    expect(h.testco.calls.filter((c) => c === "addLabel")).toHaveLength(1);
    expect(h.data.tickets["testco/TST-2"].label).toBe("add-pending");
  });

  it("looks the label up afresh after Linear rejects a label change", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");
    await h.sync();
    h.data.tickets[KEY].label = "add-pending";
    h.testco.tickets[0].labelIds = [];
    // The label was deleted in Linear and made again with a new id
    h.testco.labels.set("flow-focus", "label-recreated");

    await h.sync();
    expect(h.runner.getStatus("testco").error).toBe("Label not found");
    expect(h.notices).toEqual(["Linear reported an error for Testco: Label not found"]);
    await h.sync();
    expect(h.testco.tickets[0].labelIds).toEqual(["label-recreated"]);
    expect(h.data.tickets[KEY].label).toBe("synced");
  });

  it("forgets earlier sightings when a pass can't read Linear", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1")];
    h.data.tickets[KEY] = record("synced");
    h.local = [KEY];
    h.restart();

    await h.sync();
    h.clock.now += CONFIRM_MS;
    h.testco.failNext("getTicketsByIds", "network");
    await h.sync();
    // The pass after the failure starts the wait again rather than removing at once
    h.clock.now += 1000;
    await h.sync();

    expect(h.testco.writes).toEqual([]);
  });
});

describe("stopping", () => {
  it("starts no more runs and saves nothing once stopped mid-run", async () => {
    const h = new Harness([workspace("testco"), workspace("otherco")]);
    h.linear.set("linear-otherco", new LinearWorkspace("otherco", "Otherco"));
    h.secrets.set("linear-otherco", "linear-otherco");
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");
    const getById = h.testco.getTicketsByIds.bind(h.testco);
    h.testco.getTicketsByIds = async (ids, labelIds) => {
      h.runner.stop();
      return getById(ids, labelIds);
    };

    await h.sync();
    await h.sync();

    expect(h.saves).toBe(0);
    expect(h.testco.writes).toEqual([]);
    expect((h.linear.get("linear-otherco") as LinearWorkspace).calls).toEqual([]);
  });
});

describe("Flow unloading mid-sync", () => {
  it("stays quiet, since the API will be found again", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1", { stateType: "completed" })];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("synced");
    const getById = h.testco.getTicketsByIds.bind(h.testco);
    h.testco.getTicketsByIds = async (ids, labelIds) => {
      h.focus.unload();
      h.flow = null;
      return getById(ids, labelIds);
    };
    const consoleError = quietConsole();

    await h.sync();

    expect(h.notices).toEqual([]);
    expect(h.runner.getStatus("testco").error).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("settings changing mid-pass", () => {
  it("writes no records from before the change and runs again", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = record("add-pending");
    const addLabel = h.testco.addLabel.bind(h.testco);
    let adds = 0;
    h.testco.addLabel = async (issueId, labelId) => {
      // The first time, settings change while Linear is answering
      if (++adds === 1) h.generation++;
      return addLabel(issueId, labelId);
    };

    await h.sync();

    // The first pass's record write was refused; the rerun recorded the label
    expect(adds).toBe(1);
    expect(h.data.tickets[KEY].label).toBe("synced");
    expect(h.runner.getStatus("testco").error).toBeUndefined();
  });
});

describe("label renamed in settings", () => {
  it("takes the old label off, then puts the new one on tickets with unfinished items", async () => {
    const h = new Harness();
    h.testco.labels.set("new-focus", "label-new");
    h.testco.tickets = [labelled("TST-1"), labelled("TST-2")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets[KEY] = { ...record("synced"), labelName: "flow-focus" };
    h.data.tickets["testco/TST-2"] = {
      ...record("remove-pending", "TST-2"),
      labelName: "flow-focus",
    };
    h.data.settings.labelName = "new-focus";

    await h.sync();
    expect(h.testco.writes).toEqual(["remove label TST-1", "remove label TST-2"]);
    expect(h.data.tickets).toEqual({ [KEY]: record("add-pending") });

    await h.sync();
    expect(h.testco.tickets[0].labelIds).toEqual(["label-new"]);
    expect(h.testco.tickets[1].labelIds).toEqual([]);
    expect(h.data.tickets).toEqual({ [KEY]: record("synced") });
  });
});

describe("failures", () => {
  it("skips a workspace with no key on this device, without a notice", async () => {
    const h = new Harness();
    h.secrets.clear();
    await h.sync();
    expect(h.runner.getStatus("testco")).toEqual({ error: NO_KEY_STATUS });
    expect(h.notices).toEqual([]);
    expect(h.testco.calls).toEqual([]);
  });

  it("stays idle after Linear refuses the key, until the key changes", async () => {
    const h = new Harness();
    h.testco.failNext("findWorkspaceLabel", "auth");

    await h.sync();
    await h.sync();
    expect(h.testco.calls).toEqual(["findWorkspaceLabel"]);
    expect(h.notices).toEqual([
      "Linear refused the API key for Testco. Check it in Flow Linear's settings.",
    ]);

    h.secrets.set("linear-testco", "linear-new");
    h.linear.set("linear-new", h.testco);
    await h.sync();
    expect(h.runner.getStatus("testco").error).toBeUndefined();
  });

  it("skips a rate-limited workspace until the next interval", async () => {
    const h = new Harness();
    h.testco.failNext("findWorkspaceLabel", "rate-limit");
    await h.sync();
    h.clock.now += 60_000;
    await h.sync();
    expect(h.testco.calls).toEqual(["findWorkspaceLabel"]);
    expect(h.notices).toEqual([]);

    h.clock.now += 5 * 60_000;
    await h.sync();
    expect(h.runner.getStatus("testco").lastSuccessAt).toBe(h.clock.now);
  });

  it("notifies once per workspace and kind of problem, and carries on with other workspaces", async () => {
    const h = new Harness([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    other.tickets = [labelled("OTH-1", { urlKey: "otherco" })];
    h.linear.set("linear-otherco", other);
    h.secrets.set("linear-otherco", "linear-otherco");
    h.testco.failNext("getLabelledTickets", "network");

    await h.sync();
    h.testco.failNext("getLabelledTickets", "network");
    await h.passTime(CONFIRM_MS);

    expect(h.notices).toEqual(["Couldn't reach Linear for Testco"]);
    expect(h.focus.items.map((i) => i.external.externalId)).toEqual(["OTH-1"]);

    h.testco.failNext("getLabelledTickets", "auth");
    await h.sync();
    expect(h.notices).toHaveLength(2);
  });

  it("does nothing without Flow", async () => {
    const h = new Harness();
    h.flow = null;
    await h.sync();
    expect(h.testco.calls).toEqual([]);
  });
});

describe("one run at a time", () => {
  it("queues a single follow-up for requests made during a run", async () => {
    const h = new Harness();
    let runs = 0;
    const getLabelled = h.testco.getLabelledTickets.bind(h.testco);
    h.testco.getLabelledTickets = async (id, labelIds) => {
      runs++;
      return getLabelled(id, labelIds);
    };

    const first = h.sync();
    const second = h.sync();
    const third = h.sync();
    await Promise.all([first, second, third]);

    expect(runs).toBe(2);
    expect(second).toBe(first);
  });

  it("doesn't lose a request made as a run is finishing", async () => {
    const h = new Harness();
    let runs = 0;
    const getLabelled = h.testco.getLabelledTickets.bind(h.testco);
    h.testco.getLabelledTickets = async (id, labelIds) => {
      runs++;
      return getLabelled(id, labelIds);
    };
    // Make a request after the loop has checked the queue for the last time but before the
    // run is cleared, which is the gap a lost request would fall into
    const runner = h.runner as unknown as { runUntilSettled(): Promise<void> };
    const loop = runner.runUntilSettled.bind(h.runner);
    runner.runUntilSettled = async () => {
      runner.runUntilSettled = loop;
      await loop();
      void h.sync();
    };

    await h.sync();
    await new Promise((resolve) => setImmediate(resolve));

    expect(runs).toBe(2);
  });

  it("starts a fresh run once the last one has finished", async () => {
    const h = new Harness();
    await h.sync();
    await h.sync();
    expect(h.testco.calls.filter((c) => c === "findWorkspaceLabel")).toHaveLength(1);
    expect(h.runner.getStatus("testco").lastSuccessAt).toBe(h.clock.now);
  });
});

describe("two workspaces", () => {
  it("keeps tickets with the same identifier apart", async () => {
    const h = new Harness([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    h.linear.set("linear-otherco", other);
    h.secrets.set("linear-otherco", "linear-otherco");
    h.testco.tickets = [labelled("ABC-1")];
    other.tickets = [labelled("ABC-1", { urlKey: "otherco" })];

    await h.settle();

    expect(Object.keys(h.data.tickets).sort()).toEqual(["otherco/ABC-1", "testco/ABC-1"]);
    expect(h.focus.items.map((i) => i.external.sourceLabel).sort()).toEqual(["Testco", "otherco"]);
  });
});
