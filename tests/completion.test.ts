// ABOUTME: Tests completing Focus items whose Linear tickets are done, cancelled or trashed.
// ABOUTME: Runs the checker against an in-memory Focus list and Linear workspace.

import {
  CompletionChecker,
  NO_KEY_STATUS,
  planCompletionCheck,
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

  /** How many times the tickets were looked up in Linear. */
  lookups(client = this.testco): number {
    return client.calls.filter((call) => call === "getTickets").length;
  }

  check(): Promise<void> {
    return this.checker.requestCheck();
  }
}

function quietConsole(method: "error" | "warn" = "error") {
  return jest.spyOn(console, method).mockImplementation(() => {});
}

function otherWorkspace(d: Device): LinearWorkspace {
  const other = new LinearWorkspace("otherco", "Otherco");
  d.linear.set("linear-otherco", other);
  d.secrets.set("linear-otherco", "linear-otherco");
  return other;
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

describe("planCompletionCheck", () => {
  const item = focusItem("TST-1");
  const items = new Map([["TST-1", [item]]]);
  const plan = (found: ReturnType<typeof ticket> | null) =>
    planCompletionCheck(items, new Map([["TST-1", found]]));

  it.each(["completed", "canceled"])("completes the items of a %s ticket", (stateType) => {
    expect(plan(ticket("TST-1", { stateType }))).toEqual({
      complete: [{ itemId: item.id, identifier: "TST-1", reason: "closed" }],
      update: [],
      notVisible: [],
    });
  });

  it.each(["triage", "backlog", "unstarted", "started"])(
    "leaves a %s ticket's items",
    (stateType) => {
      expect(plan(ticket("TST-1", { stateType }))).toEqual({
        complete: [],
        update: [],
        notVisible: [],
      });
    }
  );

  it("completes the items of a trashed ticket", () => {
    expect(plan(ticket("TST-1", { trashed: true })).complete).toEqual([
      { itemId: item.id, identifier: "TST-1", reason: "deleted" },
    ]);
  });

  it("never completes the items of a ticket Linear didn't return", () => {
    // The key may not see it: wrong key, a key limited to other teams, or a private team
    expect(plan(null)).toEqual({ complete: [], update: [], notVisible: ["TST-1"] });
  });

  it("relinks the items of an open ticket that now has another identifier", () => {
    const moved = ticket("NEW-7", { url: "https://linear.app/testco/issue/NEW-7/some-title" });
    expect(plan(moved)).toEqual({
      complete: [],
      update: [
        {
          itemId: item.id,
          changes: {
            url: "https://linear.app/testco/issue/NEW-7/some-title",
            externalId: "NEW-7",
          },
        },
      ],
      notVisible: [],
    });
  });

  it("sets, changes and clears the project name to match the ticket", () => {
    const inProject = focusItem("TST-1", {
      external: { ...item.external, projectName: "Old project" },
    });
    const plain = focusItem("TST-1");
    const both = new Map([["TST-1", [inProject, plain]]]);

    expect(
      planCompletionCheck(both, new Map([["TST-1", ticket("TST-1", { projectName: "Launch" })]]))
        .update
    ).toEqual([
      { itemId: inProject.id, changes: { projectName: "Launch" } },
      { itemId: plain.id, changes: { projectName: "Launch" } },
    ]);
    // Removed from its project: null clears it, and an item with no project is left alone
    expect(planCompletionCheck(both, new Map([["TST-1", ticket("TST-1")]])).update).toEqual([
      { itemId: inProject.id, changes: { projectName: null } },
    ]);
  });

  it("leaves project names alone when they already match, or when told to", () => {
    const named = focusItem("TST-1", { external: { ...item.external, projectName: "Launch" } });
    const tickets = new Map([["TST-1", ticket("TST-1", { projectName: "Launch" })]]);
    expect(planCompletionCheck(new Map([["TST-1", [named]]]), tickets).update).toEqual([]);
    expect(planCompletionCheck(items, tickets, { projectNames: false }).update).toEqual([]);
  });

  it("sends a move and a project change as one update", () => {
    const moved = ticket("NEW-7", { projectName: "Launch" });
    expect(plan(moved).update).toEqual([
      {
        itemId: item.id,
        changes: { url: moved.url, externalId: "NEW-7", projectName: "Launch" },
      },
    ]);
  });

  it("leaves items whose ticket wasn't looked up", () => {
    expect(planCompletionCheck(items, new Map())).toEqual({
      complete: [],
      update: [],
      notVisible: [],
    });
  });
});

describe("CompletionChecker", () => {
  it("completes every unfinished item of a closed ticket, and leaves open ones", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { stateType: "completed" }), ticket("TST-2")];
    d.focus.items = [focusItem("TST-1"), focusItem("TST-1"), focusItem("TST-2")];

    await d.check();

    expect(d.focus.items.map((i) => i.completedAt !== undefined)).toEqual([true, true, false]);
    expect(d.testco.calls).toEqual(["getOrganization", "getTickets"]);
    expect(d.checker.getStatus("testco")).toEqual({ lastSuccessAt: d.clock });
  });

  it("completes the items of a trashed ticket and logs it once done", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { trashed: true })];
    d.focus.items = [focusItem("TST-1")];
    const warn = quietConsole("warn");
    const complete = d.focus.completeFocusItem.bind(d.focus);
    d.focus.completeFocusItem = async (id) => {
      expect(warn).not.toHaveBeenCalled();
      return complete(id);
    };

    await d.check();

    expect(d.focus.items[0].completedAt).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      "Flow Linear: TST-1 was deleted in Testco, so its Focus item was completed"
    );
    warn.mockRestore();
  });

  it("doesn't log a deletion when the completion fails", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { trashed: true })];
    d.focus.items = [focusItem("TST-1")];
    d.focus.completeFocusItem = async () => {
      throw new Error("Focus file is locked");
    };
    const warn = quietConsole("warn");
    const consoleError = quietConsole();

    await d.check();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    consoleError.mockRestore();
  });

  it("leaves a ticket the key can't see, and says so in the status and once as a notice", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-2")];
    d.focus.items = [focusItem("ABC-12"), focusItem("ABC-40"), focusItem("TST-2")];

    await d.check();
    await d.check();

    expect(d.focus.items.every((i) => i.completedAt === undefined)).toBe(true);
    expect(d.checker.getStatus("testco")).toEqual({
      lastSuccessAt: d.clock,
      notVisible: ["ABC-12", "ABC-40"],
    });
    expect(d.notices).toEqual([
      "Flow Linear, Testco: 2 tickets not visible with this key: ABC-12, ABC-40",
    ]);
  });

  it("skips the workspace when its key belongs to another Linear workspace", async () => {
    const d = new Device();
    // Another device's secret of the same name holds a key for "otherco"
    d.linear.set("linear-testco", new LinearWorkspace("otherco", "Otherco"));
    d.focus.items = [focusItem("TST-1")];

    await d.check();

    expect(d.testco.calls).toEqual(["getOrganization"]);
    expect(d.focus.items[0].completedAt).toBeUndefined();
    const message =
      'The API key for Testco belongs to the Linear workspace "otherco", not "testco". Check the key in Flow Linear\'s settings.';
    expect(d.checker.getStatus("testco").error).toBe(message);
    expect(d.notices).toEqual([message]);
  });

  it("relinks the items of a ticket that moved team, then looks it up by its new identifier", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("NEW-7", { id: "uuid-moved" })];
    d.testco.oldIdentifiers.set("TST-1", "uuid-moved");
    const item = focusItem("TST-1");
    d.focus.items = [item];

    await d.check();

    expect(d.focus.writes).toEqual([`update ${item.id}`]);
    expect(d.focus.items[0].external.url).toBe("https://linear.app/testco/issue/NEW-7/some-title");
    expect(d.focus.items[0].external.externalId).toBe("NEW-7");
    expect(d.focus.items[0].completedAt).toBeUndefined();

    // A different ticket now has the old identifier; it mustn't be taken for this one
    d.testco.oldIdentifiers.clear();
    d.testco.tickets.push(ticket("TST-1", { id: "uuid-new", stateType: "completed" }));
    const lookUp = jest.spyOn(d.testco, "getTickets");
    await d.check();

    expect(lookUp).toHaveBeenCalledWith(["NEW-7"]);
    expect(d.focus.items[0].completedAt).toBeUndefined();
  });

  it("still relinks with a Flow build that ignores externalId", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("NEW-7", { id: "uuid-moved" })];
    d.testco.oldIdentifiers.set("TST-1", "uuid-moved");
    d.focus.items = [focusItem("TST-1")];
    // Flow before externalId could be changed reads only the fields it knows
    const update = d.focus.updateFocusItem.bind(d.focus);
    d.focus.updateFocusItem = (id, { text, sphere, sourceLabel, url }) =>
      update(id, { text, sphere, sourceLabel, url });

    await d.check();
    expect(d.focus.items[0].external.url).toBe("https://linear.app/testco/issue/NEW-7/some-title");
    expect(d.focus.items[0].external.externalId).toBe("TST-1");
    expect(d.checker.getStatus("testco").error).toBeUndefined();

    // Later checks go by the link, so they find the ticket under its new identifier
    const lookUp = jest.spyOn(d.testco, "getTickets");
    await d.check();
    expect(lookUp).toHaveBeenCalledWith(["NEW-7"]);
  });

  it("keeps each item's project name in step with its ticket", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { projectName: "Launch" })];
    d.focus.items = [focusItem("TST-1")];

    await d.check();
    expect(d.focus.items[0].external.projectName).toBe("Launch");

    d.testco.tickets[0].projectName = "Relaunch";
    await d.check();
    expect(d.focus.items[0].external.projectName).toBe("Relaunch");

    d.testco.tickets[0].projectName = null;
    await d.check();
    expect(d.focus.items[0].external.projectName).toBeUndefined();

    // Nothing to change: no more writes
    const writes = d.focus.writes.length;
    await d.check();
    expect(d.focus.writes).toHaveLength(writes);
  });

  it("stops sending project names to a Flow build that drops them", async () => {
    const d = new Device();
    d.testco.tickets = [ticket("TST-1", { projectName: "Launch" })];
    d.focus.items = [focusItem("TST-1")];
    // Flow before projectName reads only the fields it knows
    const update = d.focus.updateFocusItem.bind(d.focus);
    d.focus.updateFocusItem = (id, { text, sphere, sourceLabel, url, externalId }) =>
      update(id, { text, sphere, sourceLabel, url, externalId });

    await d.check();
    await d.check();
    await d.check();

    // One attempt, then no more writes every check
    expect(d.focus.writes).toHaveLength(1);
    expect(d.checker.getStatus("testco").error).toBeUndefined();
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
    otherWorkspace(d).tickets = [ticket("ABC-1", { urlKey: "otherco", stateType: "completed" })];
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
    expect(d.lookups()).toBe(1);
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
    expect(d.lookups()).toBe(1);
    expect(d.notices).toEqual([]);

    d.clock += 5 * 60_000;
    await d.check();
    expect(d.checker.getStatus("testco").lastSuccessAt).toBe(d.clock);
  });

  it("notifies once per workspace and kind of problem, and carries on with other workspaces", async () => {
    const d = new Device([workspace("testco"), workspace("otherco")]);
    otherWorkspace(d).tickets = [ticket("OTH-1", { urlKey: "otherco", stateType: "completed" })];
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

  it("stays quiet when Flow unloads mid-check, and writes nothing more", async () => {
    const d = new Device();
    d.focus.items = [focusItem("TST-1"), focusItem("TST-2")];
    d.testco.tickets = [
      ticket("TST-1", { stateType: "completed" }),
      ticket("TST-2", { stateType: "completed" }),
    ];
    const complete = d.focus.completeFocusItem.bind(d.focus);
    d.focus.completeFocusItem = async (id) => {
      await complete(id);
      // Flow unloads after the first completion
      d.focus.unload();
      d.flow = null;
    };
    const consoleError = quietConsole();

    await d.check();

    expect(d.focus.items.map((i) => i.completedAt !== undefined)).toEqual([true, false]);
    expect(d.notices).toEqual([]);
    expect(d.checker.getStatus("testco").error).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("stopping", () => {
  it("starts no more checks and stops a running one between steps", async () => {
    const d = new Device([workspace("testco"), workspace("otherco")]);
    const other = otherWorkspace(d);
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

    expect(d.lookups()).toBe(2);
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

    expect(d.lookups()).toBe(2);
  });
});
