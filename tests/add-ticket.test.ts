// ABOUTME: Tests the add-ticket steps: looking a URL up and adding the ticket to Focus.
// ABOUTME: Covers unknown workspaces, closed tickets, empty wording and the records it writes.

import { AddTicket, FoundTicket } from "../src/add-ticket";
import { FlowApi } from "../src/flow-api";
import { readStoredData } from "../src/settings";
import { labelled, ticket, workspace } from "./helpers/builders";
import { FocusStore } from "./helpers/focus-store";
import { LinearWorkspace } from "./helpers/linear-workspace";

function setUp() {
  const focus = new FocusStore();
  const linear = new LinearWorkspace();
  const data = readStoredData(null);
  data.settings.workspaces = [workspace()];
  const secrets = new Map([["linear-testco", "key"]]);
  const state = { flow: focus as FlowApi | null, syncs: 0, saves: 0 };
  const addTicket = new AddTicket({
    getFlowApi: () => state.flow,
    getData: () => data,
    saveData: async () => {
      state.saves++;
    },
    getSecret: (name) => secrets.get(name) ?? null,
    createClient: () => linear,
    requestSync: () => {
      state.syncs++;
    },
  });
  return { focus, linear, data, secrets, state, addTicket };
}

async function found(addTicket: AddTicket, url: string): Promise<FoundTicket> {
  const result = await addTicket.lookUp(url);
  if (!result.ok) throw new Error(result.error);
  return result.found;
}

describe("lookUp", () => {
  it("finds an open ticket in a set-up workspace", async () => {
    const { addTicket, linear } = setUp();
    linear.tickets = [ticket("TST-4", { title: "Ship it" })];
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4/ship-it?x=1");
    expect(result.ticket.title).toBe("Ship it");
    expect(result.ticketKey).toBe("testco/TST-4");
    expect(result.workspace.urlKey).toBe("testco");
  });

  it("refuses something that isn't a ticket link", async () => {
    const { addTicket } = setUp();
    await expect(addTicket.lookUp("https://linear.app/testco/project/x")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("isn't a Linear ticket link"),
    });
  });

  it("names the set-up workspaces when the link is for another one", async () => {
    const { addTicket } = setUp();
    await expect(addTicket.lookUp("https://linear.app/elsewhere/issue/ELS-1")).resolves.toEqual({
      ok: false,
      error: 'The workspace "elsewhere" isn\'t set up. Set up: Testco (testco).',
    });
  });

  it("points to settings when no workspaces are set up", async () => {
    const { addTicket, data } = setUp();
    data.settings.workspaces = [];
    const result = await addTicket.lookUp("https://linear.app/testco/issue/TST-1");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Add one in Flow Linear") });
  });

  it("refuses when this device has no key for the workspace", async () => {
    const { addTicket, secrets } = setUp();
    secrets.clear();
    expect(await addTicket.lookUp("https://linear.app/testco/issue/TST-1")).toEqual({
      ok: false,
      error: "There's no API key for Testco on this device.",
    });
  });

  it("refuses a ticket that doesn't exist or is trashed", async () => {
    const { addTicket, linear } = setUp();
    expect(await addTicket.lookUp("https://linear.app/testco/issue/TST-1")).toEqual({
      ok: false,
      error: "TST-1 wasn't found in Testco.",
    });
    linear.tickets = [ticket("TST-1", { trashed: true })];
    expect((await addTicket.lookUp("https://linear.app/testco/issue/TST-1")).ok).toBe(false);
  });

  it.each([
    ["completed", "TST-1 is already completed in Linear."],
    ["canceled", "TST-1 is already cancelled in Linear."],
  ])("refuses a %s ticket", async (stateType, error) => {
    const { addTicket, linear, focus } = setUp();
    linear.tickets = [ticket("TST-1", { stateType })];
    expect(await addTicket.lookUp("https://linear.app/testco/issue/TST-1")).toEqual({
      ok: false,
      error,
    });
    expect(focus.items).toEqual([]);
  });

  it("reports a failure to reach Linear", async () => {
    const { addTicket, linear } = setUp();
    linear.failNext("getTicketByIdentifier", "network");
    expect(await addTicket.lookUp("https://linear.app/testco/issue/TST-1")).toEqual({
      ok: false,
      error: "Couldn't fetch the ticket from Linear: getTicketByIdentifier failed (network)",
    });
  });
});

describe("add", () => {
  it("adds the item with the chosen wording and sphere, marks the label pending and syncs", async () => {
    const { addTicket, linear, focus, data, state } = setUp();
    linear.tickets = [ticket("TST-4")];
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4");

    expect(await addTicket.add(result, "  Draft section 2  ", "personal")).toBeNull();

    expect(focus.items).toHaveLength(1);
    expect(focus.items[0]).toMatchObject({
      text: "Draft section 2",
      sphere: "personal",
      external: {
        sourceName: "linear",
        sourceLabel: "Testco",
        url: "https://linear.app/testco/issue/TST-4/some-title",
        externalId: "TST-4",
      },
    });
    expect(data.tickets["testco/TST-4"]).toEqual({
      issueId: "uuid-testco-TST-4",
      label: "add-pending",
    });
    expect(state.syncs).toBe(1);
  });

  it("adds another step for a ticket already in Focus and leaves a synced record alone", async () => {
    const { addTicket, linear, focus, data, state } = setUp();
    linear.tickets = [labelled("TST-4")];
    data.tickets["testco/TST-4"] = { issueId: "uuid-testco-TST-4", label: "synced" };
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4");

    await addTicket.add(result, "Step one", "work");
    await addTicket.add(result, "Step two", "work");

    expect(focus.items.map((i) => i.text)).toEqual(["Step one", "Step two"]);
    expect(data.tickets["testco/TST-4"].label).toBe("synced");
    expect(state.saves).toBe(0);
  });

  it("refuses empty wording or sphere and saves nothing", async () => {
    const { addTicket, linear, focus, data } = setUp();
    linear.tickets = [ticket("TST-4")];
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4");

    expect(await addTicket.add(result, "   ", "work")).toBe(
      "Enter the wording for the Focus item."
    );
    expect(await addTicket.add(result, "Wording", "")).toBe("Choose a sphere.");
    expect(focus.items).toEqual([]);
    expect(data.tickets).toEqual({});
  });

  it("refuses when Flow has gone", async () => {
    const { addTicket, linear, state } = setUp();
    linear.tickets = [ticket("TST-4")];
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4");
    state.flow = null;
    expect(await addTicket.add(result, "Wording", "work")).toBe("Flow isn't enabled");
  });

  it("reports a Focus write that Flow rejects and records nothing", async () => {
    const { addTicket, linear, focus, data, state } = setUp();
    linear.tickets = [ticket("TST-4", { url: "linear://not-a-web-link" })];
    const result = await found(addTicket, "https://linear.app/testco/issue/TST-4");

    expect(await addTicket.add(result, "Wording", "work")).toBe(
      "Couldn't add the ticket to Focus: Focus item url must be an http or https link"
    );
    expect(focus.items).toEqual([]);
    expect(data.tickets).toEqual({});
    expect(state.syncs).toBe(0);
  });
});
