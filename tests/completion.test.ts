// ABOUTME: Tests completing Focus items whose Linear tickets are done, cancelled or deleted.
// ABOUTME: Runs the checker against an in-memory Focus list and Linear workspace.

import {
  CompletionChecker,
  findItemsToComplete,
  NO_KEY_STATUS,
  unfinishedItemsByIdentifier,
} from "../src/completion";
import { FlowApi } from "../src/flow-api";
import { FlowLinearSettings, readSettings, WorkspaceSettings } from "../src/settings";
import { focusItem, ticket, workspace } from "./helpers/builders";
import { FocusStore } from "./helpers/focus-store";
import { LinearWorkspace } from "./helpers/linear-workspace";

class Device {
  focus = new FocusStore();
  linear = new Map<string, LinearWorkspace>([["linear-testco", new LinearWorkspace()]]);
  settings: FlowLinearSettings = readSettings(null);
  secrets = new Map<string, string>([["linear-testco", "linear-testco"]]);
  notices: string[] = [];
  clock = 1_000_000;
  flow: FlowApi | null = this.focus;
  checker: CompletionChecker;

  constructor(workspaces: WorkspaceSettings[] = [workspace()]) {
    this.settings.workspaces = workspaces;
    this.checker = new CompletionChecker({
      getFlowApi: () => this.flow,
      getSettings: () => this.settings,
      getSecret: (name) => this.secrets.get(name) ?? null,
      createClient: (apiKey) => {
        const client = this.linear.get(apiKey);
        if (!client) throw new Error(`No workspace for key ${apiKey}`);
        return client;
      },
      notify: (message) => this.notices.push(message),
      now: () => this.clock,
    });
  }

  get testco(): LinearWorkspace {
    return this.linear.get("linear-testco") as LinearWorkspace;
  }

  check(): Promise<void> {
    return this.checker.requestCheck();
  }
}

function quietConsole(method: "error" | "warn" = "error") {
  return jest.spyOn(console, method).mockImplementation(() => {});
}

describe("unfinishedItemsByIdentifier", () => {
  it("groups the workspace's unfinished linked items by ticket", () => {
    const one = focusItem("TST-1");
    const two = focusItem("TST-1");
    const done = focusItem("TST-2", { completedAt: 5 });
    const other = focusItem("TST-1", { urlKey: "otherco" });
    const notLinear = focusItem("TST-3");
    notLinear.external.url = "https://example.com/TST-3";

    const grouped = unfinishedItemsByIdentifier([one, two, done, other, notLinear], workspace());

    expect([...grouped.entries()]).toEqual([["TST-1", [one, two]]]);
  });
});

describe("findItemsToComplete", () => {
  const item = focusItem("TST-1");
  const items = new Map([["TST-1", [item]]]);

  it.each(["completed", "canceled"])("completes the items of a %s ticket", (stateType) => {
    expect(
      findItemsToComplete(items, new Map([["TST-1", ticket("TST-1", { stateType })]]))
    ).toEqual([{ itemId: item.id, identifier: "TST-1", reason: "closed" }]);
  });

  it.each(["triage", "backlog", "unstarted", "started"])(
    "leaves a %s ticket's items",
    (stateType) => {
      expect(
        findItemsToComplete(items, new Map([["TST-1", ticket("TST-1", { stateType })]]))
      ).toEqual([]);
    }
  );

  it("completes the items of a deleted or trashed ticket", () => {
    expect(findItemsToComplete(items, new Map([["TST-1", null]]))).toEqual([
      { itemId: item.id, identifier: "TST-1", reason: "deleted" },
    ]);
    expect(
      findItemsToComplete(items, new Map([["TST-1", ticket("TST-1", { trashed: true })]]))
    ).toEqual([{ itemId: item.id, identifier: "TST-1", reason: "deleted" }]);
  });

  it("leaves items whose ticket wasn't looked up", () => {
    expect(findItemsToComplete(items, new Map())).toEqual([]);
  });
});

describe("CompletionChecker", () => {
  it("completes every unfinished item of a closed ticket, and leaves open ones", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" }), ticket("TST-2")];
    d.focus.items = [focusItem("TST-1"), focusItem("TST-1"), focusItem("TST-2")];

    await d.check();

    expect(d.focus.items.map((i) => i.completedAt !== undefined)).toEqual([true, true, false]);
    expect(d.testco.calls).toEqual(["getTickets"]);
    expect(d.checker.getStatus("testco")).toEqual({ lastSuccessAt: d.clock });
  });

  it("completes the items of a deleted ticket and logs it", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    const warn = quietConsole("warn");

    await d.check();

    expect(d.focus.items[0].completedAt).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      "Flow Linear: TST-1 is no longer in Testco, so its Focus item was completed"
    );
    warn.mockRestore();
  });

  it("asks Linear nothing when there are no unfinished linked items", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1", { completedAt: 3 })];
    await d.check();
    expect(d.testco.calls).toEqual([]);
    expect(d.checker.getStatus("testco").lastSuccessAt).toBe(d.clock);
  });

  it("does nothing more on the next check, so running it often is harmless", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" })];
    d.focus.items = [focusItem("TST-1")];
    await d.check();
    const writes = [...d.focus.writes];

    await d.check();

    expect(d.focus.writes).toEqual(writes);
  });

  it("treats an item that has already gone or been completed as done", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" })];
    d.focus.items = [focusItem("TST-1")];
    d.focus.completeFocusItem = async () => {
      d.focus.items = [];
      throw new Error("No Focus item with id");
    };

    await d.check();

    expect(d.checker.getStatus("testco").error).toBeUndefined();
  });

  it("reports a Focus write that fails for an item that's still there, after trying the rest", async () => {
    const d = new Device();
    d.testco.tickets = [
      ticket("TST-1", { stateType: "completed" }),
      ticket("TST-2", { stateType: "completed" }),
    ];
    const first = focusItem("TST-1");
    d.focus.items = [first, focusItem("TST-2")];
    const complete = d.focus.completeFocusItem.bind(d.focus);
    d.focus.completeFocusItem = async (id) => {
      if (id === first.id) throw new Error("Focus file is locked");
      return complete(id);
    };
    const consoleError = quietConsole();

    await d.check();

    expect(d.focus.items[1].completedAt).toBeDefined();
    expect(d.checker.getStatus("testco").error).toBe("Focus file is locked");
    expect(d.notices).toEqual(["Flow Linear couldn't check Testco: Focus file is locked"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("keeps workspaces apart, even with the same identifier", async () => {
    const d = new Device([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    other.tickets = [ticket("ABC-1", { urlKey: "otherco", stateType: "completed" })];
    d.linear.set("linear-otherco", other);
    d.secrets.set("linear-otherco", "linear-otherco");
    d.testco.tickets = [ticket("ABC-1")];
    d.focus.items = [focusItem("ABC-1"), focusItem("ABC-1", { urlKey: "otherco" })];

    await d.check();

    expect(d.focus.items.map((i) => i.completedAt !== undefined)).toEqual([false, true]);
  });
});

describe("failures", () => {
  it("skips a workspace with no key on this device, without a notice", async () => {
    const d = new Device();
    d.secrets.clear();
    d.focus.items = [focusItem("TST-1")];
    await d.check();
    expect(d.checker.getStatus("testco")).toEqual({ error: NO_KEY_STATUS });
    expect(d.notices).toEqual([]);
    expect(d.testco.calls).toEqual([]);
  });

  it("stays idle after Linear refuses the key, until the key changes", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    d.testco.tickets = [ticket("TST-1")];
    d.testco.failNext("getTickets", "auth");

    await d.check();
    await d.check();
    expect(d.testco.calls).toEqual(["getTickets"]);
    expect(d.notices).toEqual([
      "Linear refused the API key for Testco. Check it in Flow Linear's settings.",
    ]);

    d.secrets.set("linear-testco", "linear-new");
    d.linear.set("linear-new", d.testco);
    await d.check();
    expect(d.checker.getStatus("testco").error).toBeUndefined();
  });

  it("skips a rate-limited workspace until the next interval", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    d.testco.tickets = [ticket("TST-1")];
    d.testco.failNext("getTickets", "rate-limit");
    await d.check();
    d.clock += 60_000;
    await d.check();
    expect(d.testco.calls).toEqual(["getTickets"]);
    expect(d.notices).toEqual([]);

    d.clock += 5 * 60_000;
    await d.check();
    expect(d.checker.getStatus("testco").lastSuccessAt).toBe(d.clock);
  });

  it("notifies once per workspace and kind of problem, and carries on with other workspaces", async () => {
    const d = new Device([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    other.tickets = [ticket("OTH-1", { urlKey: "otherco", stateType: "completed" })];
    d.linear.set("linear-otherco", other);
    d.secrets.set("linear-otherco", "linear-otherco");
    d.focus.items = [focusItem("TST-1"), focusItem("OTH-1", { urlKey: "otherco" })];
    d.testco.tickets = [ticket("TST-1")];

    d.testco.failNext("getTickets", "network");
    await d.check();
    d.testco.failNext("getTickets", "network");
    await d.check();
    expect(d.notices).toEqual(["Couldn't reach Linear for Testco"]);
    expect(d.focus.items[1].completedAt).toBeDefined();

    d.testco.failNext("getTickets", "api");
    await d.check();
    expect(d.notices[1]).toBe("Linear reported an error for Testco: getTickets failed (api)");
  });

  it("does nothing without Flow", async () => {
    const d = new Device();
    d.flow = null;
    await d.check();
    expect(d.testco.calls).toEqual([]);
  });

  it("stays quiet when Flow unloads mid-check", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" })];
    const getTickets = d.testco.getTickets.bind(d.testco);
    d.testco.getTickets = async (identifiers) => {
      d.focus.unload();
      d.flow = null;
      return getTickets(identifiers);
    };
    const consoleError = quietConsole();

    await d.check();

    expect(d.notices).toEqual([]);
    expect(d.checker.getStatus("testco").error).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("stopping", () => {
  it("starts no more checks and stops a running one between steps", async () => {
    const d = new Device([workspace("testco"), workspace("otherco")]);
    const other = new LinearWorkspace("otherco", "Otherco");
    d.linear.set("linear-otherco", other);
    d.secrets.set("linear-otherco", "linear-otherco");
    d.focus.items = [focusItem("TST-1"), focusItem("OTH-1", { urlKey: "otherco" })];
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" })];
    const getTickets = d.testco.getTickets.bind(d.testco);
    d.testco.getTickets = async (identifiers) => {
      d.checker.stop();
      return getTickets(identifiers);
    };

    await d.check();
    await d.check();

    expect(d.focus.writes).toEqual([]);
    expect(other.calls).toEqual([]);
  });
});

describe("one check at a time", () => {
  it("queues a single follow-up for requests made during a check", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    d.testco.tickets = [ticket("TST-1")];

    const first = d.check();
    const second = d.check();
    const third = d.check();
    await Promise.all([first, second, third]);

    expect(d.testco.calls).toEqual(["getTickets", "getTickets"]);
    expect(second).toBe(first);
  });

  it("doesn't lose a request made as a check is finishing", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1")];
    d.testco.tickets = [ticket("TST-1")];
    // Make a request after the loop has checked the queue for the last time but before the
    // check is cleared, which is the gap a lost request would fall into
    const checker = d.checker as unknown as { runUntilSettled(): Promise<void> };
    const loop = checker.runUntilSettled.bind(d.checker);
    checker.runUntilSettled = async () => {
      checker.runUntilSettled = loop;
      await loop();
      void d.check();
    };

    await d.check();
    await new Promise((resolve) => setImmediate(resolve));

    expect(d.testco.calls).toEqual(["getTickets", "getTickets"]);
  });
});
