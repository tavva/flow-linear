// ABOUTME: Tests the settings tab's declarative definitions and how it stores changed values.
// ABOUTME: Covers the workspace list, deleting a workspace, the sync controls and status rows.

import { Events, FakeElement, Modal, Setting } from "obsidian";
import FlowLinearPlugin from "../src/main";
import { describeStatus, FlowLinearSettingTab, OLD_FLOW_WARNING } from "../src/settings-tab";
import { WorkspaceModal } from "../src/workspace-modal";
import { workspace } from "./helpers/builders";

type Group = {
  type: string;
  heading?: string;
  visible?: boolean;
  items: {
    name: string;
    desc?: string;
    control?: { key: string; validate?(v: unknown): unknown };
  }[];
  addItem?: { action(el: unknown): void };
  onDelete?(index: number): void;
};

function unload(plugin: FlowLinearPlugin): void {
  (plugin as unknown as { unload(): void }).unload();
}

async function setUp() {
  const app = {
    workspace: Object.assign(new Events(), { onLayoutReady: () => {} }),
    secretStorage: { getSecret: () => null },
  };
  const plugin = new FlowLinearPlugin(app as never, {} as never);
  await plugin.onload();
  plugin.settings.workspaces = [workspace("testco"), workspace("otherco", { defaultSphere: "" })];
  const tab = new FlowLinearSettingTab(app as never, plugin);
  const groups = () => tab.getSettingDefinitions() as unknown as Group[];
  const group = (heading: string) => {
    const found = groups().find((g) => g.heading === heading);
    if (!found) throw new Error(`No group ${heading}`);
    return found;
  };
  return { plugin, tab, groups, group };
}

beforeEach(() => {
  // setImmediate stays real so tests can wait for button handlers to finish
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("FlowLinearSettingTab", () => {
  it("lists workspaces with their urlKey and default sphere", async () => {
    const { group, plugin } = await setUp();
    const list = group("Workspaces");
    expect(list.type).toBe("list");
    expect(list.heading).toBe("Workspaces");
    expect(list.items).toEqual([
      { name: "Testco", desc: "testco · default sphere: work" },
      { name: "otherco", desc: "otherco · default sphere: Flow's first sphere" },
    ]);
    unload(plugin);
  });

  it("deletes a workspace and saves", async () => {
    const { group, plugin, tab } = await setUp();
    const save = jest.spyOn(plugin, "saveSettings");
    group("Workspaces").onDelete?.(0);
    await Promise.resolve();
    expect(plugin.settings.workspaces.map((w) => w.urlKey)).toEqual(["otherco"]);
    expect(save).toHaveBeenCalled();
    await Promise.resolve();
    expect((tab as unknown as { updates: number }).updates).toBe(1);
    unload(plugin);
  });

  it("opens the workspace form from the add button", async () => {
    Modal.opened = [];
    const { group, plugin } = await setUp();
    group("Workspaces").addItem?.action({});
    expect(Modal.opened[0]).toBeInstanceOf(WorkspaceModal);
    unload(plugin);
  });

  it("stores the label name, refusing an empty one", async () => {
    const { tab, plugin, group } = await setUp();
    const labelControl = group("Sync").items[0].control;
    expect(labelControl?.key).toBe("labelName");
    expect(labelControl?.validate?.("  ")).toBe("Enter a label name.");
    expect(labelControl?.validate?.("ben-focus")).toBeUndefined();

    await tab.setControlValue("labelName", "  ben-focus ");
    expect(tab.getControlValue("labelName")).toBe("ben-focus");
    await tab.setControlValue("labelName", "");
    expect(plugin.settings.labelName).toBe("ben-focus");
    unload(plugin);
  });

  it("stores the interval and restarts the check timer", async () => {
    const { tab, plugin, group } = await setUp();
    const restart = jest.spyOn(plugin, "restartCheckInterval");
    const intervalControl = group("Sync").items[1].control;
    expect(intervalControl?.validate?.(0)).toBe("Check at least once a minute.");
    expect(intervalControl?.validate?.(2)).toBeUndefined();

    await tab.setControlValue("checkIntervalMinutes", 2.6);
    expect(tab.getControlValue("checkIntervalMinutes")).toBe(3);
    expect(restart).toHaveBeenCalled();
    unload(plugin);
  });

  it("ignores unknown keys", async () => {
    const { tab, plugin } = await setUp();
    const save = jest.spyOn(plugin, "saveSettings");
    await tab.setControlValue("other", "x");
    expect(tab.getControlValue("other")).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    unload(plugin);
  });

  it("shows a status row per workspace, hidden when there are none", async () => {
    const { group, plugin } = await setUp();
    const status = group("Status");
    expect(status.heading).toBe("Status");
    expect(status.items.map((i) => i.desc)).toEqual(["Not checked yet", "Not checked yet"]);
    plugin.settings.workspaces = [];
    expect(group("Status").visible).toBe(false);
    unload(plugin);
  });
});

describe("old Flow warning", () => {
  it("shows first, until dismissed, and dismissing saves", async () => {
    const { groups, plugin, tab } = await setUp();
    const [warning] = groups();
    expect(warning.visible).toBe(true);
    expect(warning.cls).toBe("flow-linear-warning");
    expect(warning.items[0].desc).toBe(OLD_FLOW_WARNING);
    expect(OLD_FLOW_WARNING).toContain("Flow 1.3.12 and earlier");

    const setting = new Setting(new FakeElement());
    warning.items[0].render?.(setting);
    expect(setting.buttons[0].text).toBe("Dismiss");
    await setting.buttons[0].click();
    await new Promise((resolve) => setImmediate(resolve));

    expect(plugin.settings.oldFlowWarningDismissed).toBe(true);
    expect(
      (plugin as unknown as { stored: { settings: { oldFlowWarningDismissed: boolean } } }).stored
        .settings.oldFlowWarningDismissed
    ).toBe(true);
    expect((tab as unknown as { updates: number }).updates).toBe(1);
    expect(groups()[0].visible).toBe(false);
    unload(plugin);
  });
});

describe("describeStatus", () => {
  it("prefers the error, then the last check time", () => {
    expect(describeStatus({ error: "No API key on this device", lastSuccessAt: 5 })).toBe(
      "Last error: No API key on this device"
    );
    expect(describeStatus({ lastSuccessAt: 0 })).toBe("Not checked yet");
    expect(describeStatus({ lastSuccessAt: Date.UTC(2026, 10, 4, 9) })).toMatch(/^Last checked /);
  });
});
