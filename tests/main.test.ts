// ABOUTME: Tests the plugin's wiring: finding Flow, following its load and unload events,
// ABOUTME: debouncing Focus changes into syncs, the add-ticket command and clean-up on unload.

import { Events, Modal, Notice } from "obsidian";
import FlowLinearPlugin, { FLOW_WITHOUT_API_NOTICE } from "../src/main";
import { AddTicketModal } from "../src/add-ticket-modal";
import { FlowApi } from "../src/flow-api";
import { focusItem } from "./helpers/builders";
import { FocusStore } from "./helpers/focus-store";

class FakeWorkspace extends Events {
  private layoutCallbacks: (() => void)[] = [];
  onLayoutReady(callback: () => void): void {
    this.layoutCallbacks.push(callback);
  }
  layoutReady(): void {
    for (const callback of this.layoutCallbacks) callback();
  }
}

function setUp(flow: FlowApi | null = new FocusStore(), flowWithoutApi = false) {
  const workspace = new FakeWorkspace();
  const state = { flow, flowWithoutApi };
  const app = {
    workspace,
    secretStorage: { getSecret: (name: string) => (name === "linear-testco" ? "key" : null) },
    plugins: {
      getPlugin: (id: string) => {
        if (id !== "flow") return null;
        if (state.flowWithoutApi) return {};
        return state.flow ? { api: state.flow } : null;
      },
    },
  };
  const plugin = new FlowLinearPlugin(app as never, {} as never);
  return { plugin, workspace, state };
}

async function load(plugin: FlowLinearPlugin, workspace: FakeWorkspace) {
  await plugin.onload();
  const requestSync = jest.spyOn(plugin.runner, "requestSync").mockResolvedValue();
  workspace.layoutReady();
  return requestSync;
}

beforeEach(() => {
  jest.useFakeTimers();
  Notice.messages = [];
  Modal.opened = [];
});

afterEach(() => {
  jest.useRealTimers();
});

describe("finding Flow", () => {
  it("connects once the layout is ready and syncs straight away", async () => {
    const { plugin, workspace, state } = setUp();
    const requestSync = await load(plugin, workspace);

    expect(plugin.flowApi).toBe(state.flow);
    expect((state.flow as FocusStore).listenerCount("linear")).toBe(1);
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("stays idle with one notice when Flow's API version isn't supported", async () => {
    const store = new FocusStore();
    const flow = Object.assign(Object.create(store) as FocusStore, { apiVersion: 2 });
    const { plugin, workspace } = setUp(flow);
    const requestSync = await load(plugin, workspace);
    workspace.trigger("flow:api-ready", flow);

    expect(plugin.flowApi).toBeNull();
    expect(requestSync).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([
      "This version of Flow isn't supported by Flow Linear. Update both plugins.",
    ]);
  });

  it("refuses to sync with a Flow that has no Focus API, and says so", async () => {
    const { plugin, workspace } = setUp(null, true);
    const requestSync = await load(plugin, workspace);
    jest.advanceTimersByTime(10 * 60_000);

    expect(plugin.flowApi).toBeNull();
    expect(requestSync).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([FLOW_WITHOUT_API_NOTICE]);
  });

  it("follows Flow being unloaded and loaded again", async () => {
    const first = new FocusStore();
    const { plugin, workspace, state } = setUp(first);
    const requestSync = await load(plugin, workspace);

    workspace.trigger("flow:api-unloaded");
    expect(plugin.flowApi).toBeNull();
    expect(first.listenerCount("linear")).toBe(0);

    const second = new FocusStore();
    state.flow = second;
    workspace.trigger("flow:api-ready", second);
    expect(plugin.flowApi).toBe(second);
    expect(second.listenerCount("linear")).toBe(1);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it("looks Flow up when the ready event carries no API", async () => {
    const { plugin, workspace, state } = setUp(null);
    await load(plugin, workspace);
    expect(plugin.flowApi).toBeNull();

    state.flow = new FocusStore();
    workspace.trigger("flow:api-ready");
    expect(plugin.flowApi).toBe(state.flow);
  });
});

describe("Focus changes", () => {
  it("syncs once, two seconds after a burst of changes", async () => {
    const store = new FocusStore();
    const { plugin, workspace } = setUp(store);
    const requestSync = await load(plugin, workspace);
    requestSync.mockClear();

    await store.addFocusItem({
      text: "One",
      sphere: "work",
      sourceName: "linear",
      sourceLabel: "Testco",
      url: "https://linear.app/testco/issue/TST-1",
      externalId: "TST-1",
    });
    jest.advanceTimersByTime(1500);
    store.replaceAll([]);
    jest.advanceTimersByTime(1999);
    expect(requestSync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("ignores changes after Flow unloads", async () => {
    const store = new FocusStore();
    const { plugin, workspace } = setUp(store);
    const requestSync = await load(plugin, workspace);
    requestSync.mockClear();

    store.replaceAll([focusItem("TST-1")]);
    workspace.trigger("flow:api-unloaded");
    jest.advanceTimersByTime(5000);
    expect(requestSync).not.toHaveBeenCalled();
  });
});

describe("check interval", () => {
  it("syncs every interval and restarts when the interval changes", async () => {
    const { plugin, workspace } = setUp();
    const requestSync = await load(plugin, workspace);
    requestSync.mockClear();

    jest.advanceTimersByTime(5 * 60_000);
    expect(requestSync).toHaveBeenCalledTimes(1);

    plugin.settings.checkIntervalMinutes = 1;
    plugin.restartCheckInterval();
    jest.advanceTimersByTime(5 * 60_000);
    expect(requestSync).toHaveBeenCalledTimes(6);
  });

  it("doesn't sync without Flow", async () => {
    const { plugin, workspace } = setUp(null);
    const requestSync = await load(plugin, workspace);
    jest.advanceTimersByTime(10 * 60_000);
    expect(requestSync).not.toHaveBeenCalled();
  });
});

describe("add-ticket command", () => {
  it("is registered without a hotkey", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    const command = (plugin as unknown as { commands: { id: string; name: string }[] }).commands[0];
    expect(command).toEqual({
      id: "add-ticket-to-focus",
      name: "Add Linear ticket to Focus",
      callback: expect.any(Function),
    });
  });

  it("says Flow isn't enabled when it isn't", async () => {
    const { plugin, workspace } = setUp(null);
    await load(plugin, workspace);
    (plugin as unknown as { commands: { callback(): void }[] }).commands[0].callback();
    expect(Notice.messages).toEqual(["Flow isn't enabled"]);
    expect(Modal.opened).toEqual([]);
  });

  it("says Flow is too old when it has no Focus API", async () => {
    const { plugin, workspace } = setUp(null, true);
    await load(plugin, workspace);
    Notice.messages = [];
    (plugin as unknown as { commands: { callback(): void }[] }).commands[0].callback();
    expect(Notice.messages).toEqual([FLOW_WITHOUT_API_NOTICE]);
    expect(Modal.opened).toEqual([]);
  });

  it("opens the modal when Flow is there", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    (plugin as unknown as { commands: { callback(): void }[] }).commands[0].callback();
    expect(Modal.opened).toHaveLength(1);
    expect(Modal.opened[0]).toBeInstanceOf(AddTicketModal);
  });
});

describe("data and secrets", () => {
  it("loads stored settings and saves them back whole", async () => {
    const { plugin, workspace } = setUp();
    const stored = {
      settings: { workspaces: [], labelName: "ben-focus", checkIntervalMinutes: 3 },
      tickets: { "testco/TST-1": { issueId: "uuid-1", label: "synced" } },
    };
    (plugin as unknown as { stored: unknown }).stored = stored;
    await load(plugin, workspace);

    expect(plugin.settings.labelName).toBe("ben-focus");
    expect(plugin.data.tickets).toEqual(stored.tickets);
    plugin.settings.labelName = "other";
    await plugin.saveSettings();
    expect((plugin as unknown as { stored: typeof stored }).stored.settings.labelName).toBe(
      "other"
    );
  });

  it("reads secrets from SecretStorage and treats an empty name as no key", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    expect(plugin.getSecret("linear-testco")).toBe("key");
    expect(plugin.getSecret("")).toBeNull();
  });
});

describe("data changed on another device", () => {
  it("reloads settings and records into the same objects and syncs", async () => {
    const { plugin, workspace } = setUp();
    const requestSync = await load(plugin, workspace);
    requestSync.mockClear();
    const settings = plugin.settings;
    plugin.data.tickets["testco/OLD-1"] = { issueId: "uuid-old", label: "synced" };
    (plugin as unknown as { stored: unknown }).stored = {
      settings: { workspaces: [], labelName: "ben-focus", checkIntervalMinutes: 2 },
      tickets: { "testco/NEW-1": { issueId: "uuid-new", label: "add-pending" } },
    };

    await plugin.onExternalSettingsChange();

    expect(plugin.settings).toBe(settings);
    expect(settings.labelName).toBe("ben-focus");
    expect(plugin.data.tickets).toEqual({
      "testco/NEW-1": { issueId: "uuid-new", label: "add-pending" },
    });
    expect(requestSync).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2 * 60_000);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });
});

describe("unload", () => {
  it("unsubscribes from Flow and cancels pending syncs", async () => {
    const store = new FocusStore();
    const { plugin, workspace } = setUp(store);
    const requestSync = await load(plugin, workspace);
    requestSync.mockClear();

    store.replaceAll([focusItem("TST-1")]);
    (plugin as unknown as { unload(): void }).unload();
    jest.advanceTimersByTime(10 * 60_000);

    expect(store.listenerCount("linear")).toBe(0);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it("stops the sync runner", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    const stop = jest.spyOn(plugin.runner, "stop");
    (plugin as unknown as { unload(): void }).unload();
    expect(stop).toHaveBeenCalled();
  });
});
