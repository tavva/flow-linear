// ABOUTME: Tests the plugin's wiring: finding Flow, following its load and unload events,
// ABOUTME: the startup delay and check interval, the add-ticket command and clean-up on unload.

import { Events, Modal, Notice } from "obsidian";
import FlowLinearPlugin, {
  FLOW_WITHOUT_API_NOTICE,
  STARTUP_CHECK_DELAY_MS,
  TICK_MS,
} from "../src/main";
import { AddTicketModal } from "../src/add-ticket-modal";
import { FlowApi } from "../src/flow-api";
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

/** Load the plugin and let the layout get ready; by default also wait out the startup delay. */
async function load(plugin: FlowLinearPlugin, workspace: FakeWorkspace, waitForStartup = true) {
  await plugin.onload();
  const requestCheck = jest.spyOn(plugin.checker, "requestCheck").mockResolvedValue();
  workspace.layoutReady();
  if (waitForStartup) jest.advanceTimersByTime(STARTUP_CHECK_DELAY_MS);
  return requestCheck;
}

function commands(plugin: FlowLinearPlugin) {
  return (plugin as unknown as { commands: { id: string; name: string; callback(): void }[] })
    .commands;
}

function unload(plugin: FlowLinearPlugin) {
  (plugin as unknown as { unload(): void }).unload();
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
  it("connects once the layout is ready and first checks after the startup delay", async () => {
    const { plugin, workspace, state } = setUp();
    const requestCheck = await load(plugin, workspace, false);

    expect(plugin.flowApi).toBe(state.flow);
    jest.advanceTimersByTime(STARTUP_CHECK_DELAY_MS - 1);
    plugin.requestCheck();
    expect(requestCheck).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(requestCheck).toHaveBeenCalledTimes(1);
  });

  it("stays idle with one notice when Flow's API version isn't supported", async () => {
    const store = new FocusStore();
    const flow = Object.assign(Object.create(store) as FocusStore, { apiVersion: 2 });
    const { plugin, workspace } = setUp(flow);
    const requestCheck = await load(plugin, workspace);
    workspace.trigger("flow:api-ready", flow);

    expect(plugin.flowApi).toBeNull();
    expect(requestCheck).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([
      "This version of Flow isn't supported by Flow Linear. Update both plugins.",
    ]);
  });

  it("refuses to run with a Flow that has no Focus API, and says so", async () => {
    const { plugin, workspace } = setUp(null, true);
    const requestCheck = await load(plugin, workspace);
    jest.advanceTimersByTime(10 * 60_000);

    expect(plugin.flowApi).toBeNull();
    expect(requestCheck).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([FLOW_WITHOUT_API_NOTICE]);
  });

  it("follows Flow being unloaded and loaded again", async () => {
    const first = new FocusStore();
    const { plugin, workspace, state } = setUp(first);
    const requestCheck = await load(plugin, workspace);

    workspace.trigger("flow:api-unloaded");
    expect(plugin.flowApi).toBeNull();
    jest.advanceTimersByTime(5 * 60_000);
    expect(requestCheck).toHaveBeenCalledTimes(1);

    const second = new FocusStore();
    state.flow = second;
    workspace.trigger("flow:api-ready", second);
    jest.advanceTimersByTime(STARTUP_CHECK_DELAY_MS);
    expect(plugin.flowApi).toBe(second);
    expect(requestCheck).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending startup check when Flow unloads first", async () => {
    const { plugin, workspace } = setUp();
    const requestCheck = await load(plugin, workspace, false);
    workspace.trigger("flow:api-unloaded");
    jest.advanceTimersByTime(STARTUP_CHECK_DELAY_MS);
    expect(requestCheck).not.toHaveBeenCalled();
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

describe("check interval", () => {
  it("checks once the interval has passed, and follows a changed interval at once", async () => {
    const { plugin, workspace } = setUp();
    const requestCheck = await load(plugin, workspace);
    requestCheck.mockClear();

    // The tick runs each minute, so a check comes within a minute of the interval passing
    jest.advanceTimersByTime(4 * 60_000);
    expect(requestCheck).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000 + TICK_MS);
    expect(requestCheck).toHaveBeenCalledTimes(1);

    // No new timer is needed for a new interval
    const intervals = jest.getTimerCount();
    plugin.settings.checkIntervalMinutes = 1;
    jest.advanceTimersByTime(3 * TICK_MS);
    expect(requestCheck).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(intervals);
  });

  it("doesn't check without Flow", async () => {
    const { plugin, workspace } = setUp(null);
    const requestCheck = await load(plugin, workspace);
    jest.advanceTimersByTime(10 * 60_000);
    expect(requestCheck).not.toHaveBeenCalled();
  });
});

describe("add-ticket command", () => {
  it("is registered without a hotkey", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    expect(commands(plugin)[0]).toEqual({
      id: "add-ticket-to-focus",
      name: "Add Linear ticket to Focus",
      callback: expect.any(Function),
    });
  });

  it("says Flow isn't enabled when it isn't", async () => {
    const { plugin, workspace } = setUp(null);
    await load(plugin, workspace);
    commands(plugin)[0].callback();
    expect(Notice.messages).toEqual(["Flow isn't enabled"]);
    expect(Modal.opened).toEqual([]);
  });

  it("says Flow is too old when it has no Focus API", async () => {
    const { plugin, workspace } = setUp(null, true);
    await load(plugin, workspace);
    Notice.messages = [];
    commands(plugin)[0].callback();
    expect(Notice.messages).toEqual([FLOW_WITHOUT_API_NOTICE]);
    expect(Modal.opened).toEqual([]);
  });

  it("opens the modal when Flow is there", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    commands(plugin)[0].callback();
    expect(Modal.opened).toHaveLength(1);
    expect(Modal.opened[0]).toBeInstanceOf(AddTicketModal);
  });
});

describe("settings and secrets", () => {
  it("loads stored settings and saves them back whole", async () => {
    const { plugin, workspace } = setUp();
    const stored = { workspaces: [], checkIntervalMinutes: 3, oldFlowWarningDismissed: true };
    (plugin as unknown as { stored: unknown }).stored = stored;
    await load(plugin, workspace);

    expect(plugin.settings).toEqual(stored);
    plugin.settings.checkIntervalMinutes = 7;
    await plugin.saveSettings();
    expect((plugin as unknown as { stored: unknown }).stored).toEqual({
      ...stored,
      checkIntervalMinutes: 7,
    });
  });

  it("reloads settings changed on another device into the same object, and checks", async () => {
    const { plugin, workspace } = setUp();
    const requestCheck = await load(plugin, workspace);
    requestCheck.mockClear();
    const settings = plugin.settings;
    (plugin as unknown as { stored: unknown }).stored = {
      workspaces: [],
      checkIntervalMinutes: 2,
      oldFlowWarningDismissed: false,
    };

    await plugin.onExternalSettingsChange();

    expect(plugin.settings).toBe(settings);
    expect(settings.checkIntervalMinutes).toBe(2);
    expect(requestCheck).toHaveBeenCalledTimes(1);
    // An open settings tab is redrawn with the new settings
    const tab = (plugin as unknown as { settingTabs: { updates: number }[] }).settingTabs[0];
    expect(tab.updates).toBe(1);
    jest.advanceTimersByTime(2 * 60_000 + TICK_MS);
    expect(requestCheck).toHaveBeenCalledTimes(2);
  });

  it("reads secrets from SecretStorage and treats an empty name as no key", async () => {
    const { plugin, workspace } = setUp();
    await load(plugin, workspace);
    expect(plugin.getSecret("linear-testco")).toBe("key");
    expect(plugin.getSecret("")).toBeNull();
  });
});

describe("unload", () => {
  it("stops the checker and cancels the interval", async () => {
    const { plugin, workspace } = setUp();
    const requestCheck = await load(plugin, workspace);
    requestCheck.mockClear();
    const stop = jest.spyOn(plugin.checker, "stop");

    unload(plugin);
    jest.advanceTimersByTime(10 * 60_000);

    expect(stop).toHaveBeenCalled();
    expect(requestCheck).not.toHaveBeenCalled();
  });
});
