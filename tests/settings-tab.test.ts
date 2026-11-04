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
  const local = new Map<string, unknown>();
  const app = {
    workspace: Object.assign(new Events(), { onLayoutReady: () => {} }),
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => local.set(key, value),
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

  it("deletes a workspace from the current list and saves", async () => {
    const { group, plugin, tab } = await setUp();
    const save = jest.spyOn(plugin, "saveSettings");
    const list = group("Workspaces");
    // Settings reloaded from another device after the tab was drawn
    plugin.settings.workspaces = [workspace("testco"), workspace("thirdco")];
    list.onDelete?.(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.settings.workspaces.map((w) => w.urlKey)).toEqual(["testco"]);
    expect(save).toHaveBeenCalled();
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

  it("renames the label only when the field is left or Enter is pressed", async () => {
    const { plugin, group } = await setUp();
    const rename = jest.spyOn(plugin, "renameLabel");
    const setting = new Setting(new FakeElement());
    group("Sync").items[0].render?.(setting);
    const text = setting.texts[0];
    expect(text.value).toBe("flow-focus");

    text.type("b");
    text.type("be");
    text.type("ben-focus");
    expect(rename).not.toHaveBeenCalled();

    text.inputEl.dispatch("blur", {});
    expect(rename).toHaveBeenCalledWith("ben-focus");
    text.type(" other ");
    text.inputEl.dispatch("keydown", { key: "Enter", preventDefault() {} });
    expect(rename).toHaveBeenLastCalledWith("other");
    unload(plugin);
  });

  it("puts the current name back when the field is left empty", async () => {
    const { plugin, group } = await setUp();
    const rename = jest.spyOn(plugin, "renameLabel");
    const setting = new Setting(new FakeElement());
    group("Sync").items[0].render?.(setting);
    setting.texts[0].type("  ");
    setting.texts[0].inputEl.dispatch("blur", {});
    expect(rename).not.toHaveBeenCalled();
    expect(setting.texts[0].value).toBe("flow-focus");
    unload(plugin);
  });

  it("keeps the old label on each record so it comes off before the new one goes on", async () => {
    const { plugin } = await setUp();
    const sync = jest.spyOn(plugin, "requestSync");
    plugin.data.tickets["testco/TST-1"] = { issueId: "uuid-1", label: "synced" };
    plugin.data.tickets["testco/TST-2"] = { issueId: "uuid-2", label: "remove-pending" };
    plugin.data.tickets["testco/TST-3"] = {
      issueId: "uuid-3",
      label: "synced",
      labelName: "older",
    };

    await plugin.renameLabel("flow-focus");
    expect(plugin.data.tickets["testco/TST-1"]).toEqual({ issueId: "uuid-1", label: "synced" });
    expect(sync).not.toHaveBeenCalled();

    await plugin.renameLabel("ben-focus");
    expect(plugin.settings.labelName).toBe("ben-focus");
    expect(plugin.data.tickets).toEqual({
      "testco/TST-1": { issueId: "uuid-1", label: "synced", labelName: "flow-focus" },
      "testco/TST-2": { issueId: "uuid-2", label: "remove-pending", labelName: "flow-focus" },
      "testco/TST-3": { issueId: "uuid-3", label: "synced", labelName: "older" },
    });
    expect(sync).toHaveBeenCalled();
    unload(plugin);
  });

  it("makes a pass already running unable to save records from before the rename", async () => {
    const { plugin } = await setUp();
    const generation = (plugin as unknown as { settingsGeneration: number }).settingsGeneration;
    await plugin.renameLabel("ben-focus");
    expect((plugin as unknown as { settingsGeneration: number }).settingsGeneration).toBe(
      generation + 1
    );
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
    await tab.setControlValue("labelName", "x");
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
    // Says plainly what an old Flow does: items go, and so do labels
    expect(OLD_FLOW_WARNING).toContain("Flow 1.3.12 or earlier, it will delete your Linear items");
    expect(OLD_FLOW_WARNING).toContain("take the label off those tickets");

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
