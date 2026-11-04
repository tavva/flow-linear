// ABOUTME: Tests the sync runner against an in-memory Focus list and Linear workspace.
// ABOUTME: Covers carrying out each action, failures, confirmation of removals and run queuing.

import { FlowApi } from "../src/flow-api";
import { FlowLinearData, readStoredData, WorkspaceSettings } from "../src/settings";
import { NO_KEY_STATUS, SyncRunner } from "../src/sync-runner";
import { focusItem, labelled, ticket, workspace } from "./helpers/builders";
import { FocusStore } from "./helpers/focus-store";
import { LinearWorkspace } from "./helpers/linear-workspace";

const CONFIRM_MS = 30_000;

class Harness {
  focus = new FocusStore();
  linear = new Map<string, LinearWorkspace>([["linear-testco", new LinearWorkspace()]]);
  data: FlowLinearData = readStoredData(null);
  secrets = new Map<string, string>([["linear-testco", "linear-testco"]]);
  notices: string[] = [];
  scheduled: { callback: () => void; delayMs: number }[] = [];
  saves = 0;
  clock = 1_000_000;
  flow: FlowApi | null = this.focus;
  runner: SyncRunner;

  constructor(workspaces: WorkspaceSettings[] = [workspace()]) {
    this.data.settings.workspaces = workspaces;
    this.runner = new SyncRunner({
      getFlowApi: () => this.flow,
      getData: () => this.data,
      saveData: async () => {
        this.saves++;
      },
      getSecret: (name) => this.secrets.get(name) ?? null,
      // Each API key opens its own in-memory workspace
      createClient: (apiKey) => {
        const client = this.linear.get(apiKey);
        if (!client) throw new Error(`No workspace for key ${apiKey}`);
        return client;
      },
      notify: (message) => this.notices.push(message),
      schedule: (callback, delayMs) => this.scheduled.push({ callback, delayMs }),
      now: () => this.clock,
      removalConfirmDelayMs: CONFIRM_MS,
    });
  }

  get testco(): LinearWorkspace {
    return this.linear.get("linear-testco") as LinearWorkspace;
  }

  sync(): Promise<void> {
    return this.runner.requestSync();
  }

  /** Let time pass and run the sync the runner scheduled to confirm removals. */
  async passTime(ms: number): Promise<void> {
    this.clock += ms;
    // Stands in for the scheduled callbacks, which each request one sync
    this.scheduled = this.scheduled.filter((entry) => entry.delayMs > ms);
    await this.runner.requestSync();
  }
}

describe("importing a ticket labelled in Linear", () => {
  it("adds a Focus item and records the ticket as synced", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1", { title: "Write the plan" })];

    await h.sync();

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
    expect(h.data.tickets).toEqual({
      "testco/TST-1": { issueId: "uuid-testco-TST-1", label: "synced" },
    });
    expect(h.runner.getStatus("testco")).toEqual({ lastSuccessAt: h.clock });
  });

  it("does nothing more on the next sync, so its own change events are harmless", async () => {
    const h = new Harness();
    h.testco.tickets = [labelled("TST-1")];
    let events = 0;
    h.focus.onFocusChange("linear", () => events++);

    await h.sync();
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
    await h.sync();
    expect(h.focus.items[0].sphere).toBe("personal");
  });

  it("reports an error and keeps no record when there's no sphere at all", async () => {
    const h = new Harness([workspace("testco", { defaultSphere: "" })]);
    h.focus.spheres = [];
    h.testco.tickets = [labelled("TST-1")];
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    await h.sync();

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
    const realGet = h.focus.getFocusItems.bind(h.focus);
    let reads = 0;
    // The second read is the import's re-check; another device's item has arrived by then
    h.focus.getFocusItems = async (source) => {
      reads++;
      if (reads === 2) h.focus.items.push(focusItem("TST-1"));
      return realGet(source);
    };

    await h.sync();

    expect(h.focus.items).toHaveLength(1);
    expect(h.focus.writes).toEqual([]);
    expect(h.data.tickets["testco/TST-1"].label).toBe("synced");
  });
});

describe("adding the label for items added in Flow", () => {
  it("creates the workspace label once, adds it and marks the record synced", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1"), ticket("TST-2")];
    h.focus.items = [focusItem("TST-1"), focusItem("TST-2")];

    await h.sync();

    expect(h.testco.writes).toEqual([
      "create label flow-focus",
      "add label TST-1",
      "add label TST-2",
    ]);
    expect(h.testco.calls.filter((c) => c === "findWorkspaceLabel")).toHaveLength(1);
    expect(h.data.tickets["testco/TST-1"]).toEqual({
      issueId: "uuid-testco-TST-1",
      label: "synced",
    });
  });

  it("uses an existing workspace label", async () => {
    const h = new Harness();
    h.testco.labels.set("flow-focus", "label-existing");
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    await h.sync();
    expect(h.testco.writes).toEqual(["add label TST-1"]);
  });

  it("leaves the record unchanged when adding the label fails, and retries next time", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "add-pending" };
    h.testco.failNext("addLabel", "network");

    await h.sync();
    expect(h.data.tickets["testco/TST-1"].label).toBe("add-pending");
    expect(h.runner.getStatus("testco").error).toBe("addLabel failed (network)");
    expect(h.notices).toEqual(["Couldn't reach Linear for Testco"]);

    await h.sync();
    expect(h.data.tickets["testco/TST-1"].label).toBe("synced");
    expect(h.runner.getStatus("testco")).toEqual({ lastSuccessAt: h.clock });
  });
});

describe("removing the label", () => {
  function syncedTicket(h: Harness) {
    h.testco.labels.set("flow-focus", "label-1");
    h.testco.tickets = [labelled("TST-1")];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };
  }

  it("removes the label only when a later pass confirms the items are still gone", async () => {
    const h = new Harness();
    syncedTicket(h);
    h.focus.items = [focusItem("TST-1", { completedAt: 5 })];

    await h.sync();
    expect(h.testco.writes).toEqual([]);
    expect(h.scheduled).toEqual([{ callback: expect.any(Function), delayMs: CONFIRM_MS }]);

    // A sync soon afterwards, before the delay is up, still waits
    h.clock += 1000;
    await h.sync();
    expect(h.testco.writes).toEqual([]);

    await h.passTime(CONFIRM_MS);
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
    expect(h.focus.items).toHaveLength(1);
  });

  it("schedules a sync that confirms the removal by itself", async () => {
    const h = new Harness();
    syncedTicket(h);
    await h.sync();
    h.clock += CONFIRM_MS;
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

    h.focus.replaceAll([]);
    await h.sync();
    h.focus.replaceAll([item]);
    await h.passTime(CONFIRM_MS);
    // Gone again: the earlier sighting no longer counts
    h.focus.replaceAll([]);
    await h.sync();

    expect(h.testco.writes).toEqual([]);
    expect(h.data.tickets["testco/TST-1"].label).toBe("synced");
  });

  it("retries a failed removal on the next pass without waiting again", async () => {
    const h = new Harness();
    syncedTicket(h);
    await h.sync();
    h.testco.failNext("removeLabel", "network");
    await h.passTime(CONFIRM_MS);
    expect(h.data.tickets["testco/TST-1"].label).toBe("remove-pending");

    await h.sync();
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
  });
});

describe("changes made in Linear", () => {
  it("removes unfinished items when the label is removed in Linear", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    const open = focusItem("TST-1");
    const done = focusItem("TST-1", { completedAt: 3 });
    h.focus.items = [open, done];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };

    await h.sync();

    expect(h.focus.items.map((i) => i.id)).toEqual([done.id]);
    expect(h.data.tickets).toEqual({});
  });

  it("completes items for a closed ticket and removes its label", async () => {
    const h = new Harness();
    h.testco.labels.set("flow-focus", "label-1");
    h.testco.tickets = [labelled("TST-1", { stateType: "completed" })];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };

    await h.sync();

    expect(h.focus.items[0].completedAt).toBeDefined();
    expect(h.testco.writes).toEqual(["remove label TST-1"]);
    expect(h.data.tickets).toEqual({});
  });

  it("completes items for a deleted ticket and forgets it", async () => {
    const h = new Harness();
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };

    await h.sync();

    expect(h.focus.items[0].completedAt).toBeDefined();
    expect(h.data.tickets).toEqual({});
  });

  it("treats an item that has already gone as removed", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    const item = focusItem("TST-1");
    h.focus.items = [item];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };
    const remove = h.focus.removeFocusItem.bind(h.focus);
    h.focus.removeFocusItem = async (id) => {
      h.focus.items = [];
      return remove(id);
    };

    await h.sync();

    expect(h.data.tickets).toEqual({});
    expect(h.runner.getStatus("testco").error).toBeUndefined();
  });

  it("keeps the record when a Focus write fails for an item that's still there", async () => {
    const h = new Harness();
    h.testco.tickets = [ticket("TST-1")];
    h.focus.items = [focusItem("TST-1")];
    h.data.tickets["testco/TST-1"] = { issueId: "uuid-testco-TST-1", label: "synced" };
    h.focus.removeFocusItem = async () => {
      throw new Error("Focus file is locked");
    };
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    await h.sync();

    expect(h.data.tickets["testco/TST-1"].label).toBe("synced");
    expect(h.runner.getStatus("testco").error).toBe("Focus file is locked");
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
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
    h.testco.failNext("getLabelledTickets", "auth");

    await h.sync();
    await h.sync();
    expect(h.testco.calls).toEqual(["getLabelledTickets"]);
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
    h.testco.failNext("getLabelledTickets", "rate-limit");
    await h.sync();
    h.clock += 60_000;
    await h.sync();
    expect(h.testco.calls).toEqual(["getLabelledTickets"]);
    expect(h.notices).toEqual([]);

    h.clock += 5 * 60_000;
    await h.sync();
    expect(h.runner.getStatus("testco").lastSuccessAt).toBe(h.clock);
  });

  it("notifies once per workspace per session and carries on with other workspaces", async () => {
    const h = new Harness([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    other.tickets = [labelled("OTH-1", { urlKey: "otherco" })];
    h.linear.set("linear-otherco", other);
    h.secrets.set("linear-otherco", "linear-otherco");
    h.testco.failNext("getLabelledTickets", "network");

    await h.sync();
    h.testco.failNext("getLabelledTickets", "api");
    await h.sync();

    expect(h.notices).toEqual(["Couldn't reach Linear for Testco"]);
    expect(h.focus.items.map((i) => i.external.externalId)).toEqual(["OTH-1"]);
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
    h.testco.getLabelledTickets = async (name) => {
      runs++;
      return getLabelled(name);
    };

    const first = h.sync();
    const second = h.sync();
    const third = h.sync();
    await Promise.all([first, second, third]);

    expect(runs).toBe(2);
    expect(second).toBe(first);
  });

  it("starts a fresh run once the last one has finished", async () => {
    const h = new Harness();
    await h.sync();
    await h.sync();
    expect(h.testco.calls.filter((c) => c === "getLabelledTickets")).toHaveLength(2);
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

    await h.sync();

    expect(Object.keys(h.data.tickets).sort()).toEqual(["otherco/ABC-1", "testco/ABC-1"]);
    expect(h.focus.items.map((i) => i.external.sourceLabel).sort()).toEqual(["Testco", "otherco"]);
  });
});
