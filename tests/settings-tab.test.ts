// ABOUTME: Tests the settings tab's declarative definitions and how it stores changed values.
// ABOUTME: Covers the workspace list, deleting a workspace, the sync controls and status rows.

import { Events, FakeElement, Modal, Setting } from "obsidian";
import FlowLinearPlugin from "../src/main";
import { describeStatus, FlowLinearSettingTab, OLD_FLOW_WARNING } from "../src/settings-tab";
import { ApiKeyModal, WorkspaceModal } from "../src/workspace-modal";
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
  const secrets = new Map<string, string>([["linear-thirdco", "lin_api_third"]]);
  const app = {
    workspace: Object.assign(new Events(), { onLayoutReady: () => {} }),
    secretStorage: {
      getSecret: (name: string) => secrets.get(name) ?? null,
      setSecret: (name: string, value: string) => secrets.set(name, value),
    },
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
  return { plugin, tab, groups, group, secrets };
}

type ModalWithDeps = { deps: { onSave(...args: unknown[]): Promise<void> } };

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
    expect(list.items.map(({ name, desc }) => ({ name, desc }))).toEqual([
      { name: "Testco", desc: "testco · default sphere: work" },
      { name: "otherco", desc: "otherco · default sphere: Flow's first sphere" },
    ]);
    unload(plugin);
  });

  it("deletes a workspace from the current list, clears the key it stored and saves", async () => {
    const { group, plugin, tab, secrets } = await setUp();
    secrets.set("flow-linear-thirdco", "lin_api_third");
    const save = jest.spyOn(plugin, "saveSettings");
    const list = group("Workspaces");
    // Settings reloaded from another device after the tab was drawn
    plugin.settings.workspaces = [
      workspace("testco"),
      workspace("thirdco", { apiKeySecretName: "flow-linear-thirdco" }),
    ];
    list.onDelete?.(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.settings.workspaces.map((w) => w.urlKey)).toEqual(["testco"]);
    // SecretStorage can't delete, so the key is overwritten with an empty value
    expect(secrets.get("flow-linear-thirdco")).toBe("");
    expect(plugin.getSecret("flow-linear-thirdco")).toBe("");
    expect(save).toHaveBeenCalled();
    expect((tab as unknown as { updates: number }).updates).toBe(1);
    unload(plugin);
  });

  it("leaves alone a secret the plugin didn't name, which other plugins may share", async () => {
    const { group, plugin, secrets } = await setUp();
    // Set up with Obsidian's secret picker, under a shared name
    plugin.settings.workspaces = [workspace("thirdco", { apiKeySecretName: "linear" })];
    secrets.set("linear", "lin_api_shared");
    group("Workspaces").onDelete?.(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.settings.workspaces).toEqual([]);
    expect(secrets.get("linear")).toBe("lin_api_shared");
    unload(plugin);
  });

  it("adds a workspace from the add button, storing its key under the plugin's name", async () => {
    Modal.opened = [];
    const { group, plugin, secrets } = await setUp();
    group("Workspaces").addItem?.action({});
    expect(Modal.opened[0]).toBeInstanceOf(WorkspaceModal);

    const added = workspace("newco", { apiKeySecretName: "flow-linear-newco" });
    await (Modal.opened[0] as unknown as ModalWithDeps).deps.onSave(added, "lin_api_new");

    expect(secrets.get("flow-linear-newco")).toBe("lin_api_new");
    expect(plugin.settings.workspaces.map((w) => w.urlKey)).toContain("newco");
    unload(plugin);
  });

  it("replaces a workspace's key from its Change key button", async () => {
    Modal.opened = [];
    const { group, plugin, secrets } = await setUp();
    const setting = new Setting(new FakeElement());
    group("Workspaces").items[0].render?.(setting);
    expect(setting.buttons[0].text).toBe("Change key");

    await setting.buttons[0].click();
    expect(Modal.opened[0]).toBeInstanceOf(ApiKeyModal);
    secrets.set("linear-testco", "lin_api_shared");
    const save = jest.spyOn(plugin, "saveSettings");
    await (Modal.opened[0] as unknown as ModalWithDeps).deps.onSave("lin_api_replaced");

    // Stored under the plugin's own name, and the workspace switched to it; the secret the
    // workspace named before, which may be shared, is untouched
    expect(secrets.get("flow-linear-testco")).toBe("lin_api_replaced");
    expect(plugin.settings.workspaces[0].apiKeySecretName).toBe("flow-linear-testco");
    expect(secrets.get("linear-testco")).toBe("lin_api_shared");
    expect(save).toHaveBeenCalled();
    unload(plugin);
  });

  it("stores the interval", async () => {
    const { tab, plugin, group } = await setUp();
    const save = jest.spyOn(plugin, "saveSettings");
    const intervalControl = group("Checking Linear").items[0].control;
    expect(intervalControl?.validate?.(0)).toBe("Check at least once a minute.");
    expect(intervalControl?.validate?.(2)).toBeUndefined();

    await tab.setControlValue("checkIntervalMinutes", 2.6);
    expect(tab.getControlValue("checkIntervalMinutes")).toBe(3);
    expect(save).toHaveBeenCalled();
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
    // Says plainly what an old Flow does
    expect(OLD_FLOW_WARNING).toContain("Flow 1.3.12 or earlier, it will delete your Linear items");
    expect(OLD_FLOW_WARNING).toContain("that deletion syncs to every device");

    const setting = new Setting(new FakeElement());
    warning.items[0].render?.(setting);
    expect(setting.buttons[0].text).toBe("Dismiss");
    await setting.buttons[0].click();
    await new Promise((resolve) => setImmediate(resolve));

    expect(plugin.settings.oldFlowWarningDismissed).toBe(true);
    expect(
      (plugin as unknown as { stored: { oldFlowWarningDismissed: boolean } }).stored
        .oldFlowWarningDismissed
    ).toBe(true);
    expect((tab as unknown as { updates: number }).updates).toBe(1);
    expect(groups()[0].visible).toBe(false);
    unload(plugin);
  });
});

describe("describeStatus", () => {
  it("adds the tickets the key couldn't see", () => {
    expect(
      describeStatus({ lastSuccessAt: Date.UTC(2026, 10, 4, 9), notVisible: ["ABC-12", "ABC-40"] })
    ).toMatch(/^Last checked .+\. 2 tickets not visible with this key: ABC-12, ABC-40$/);
    expect(describeStatus({ lastSuccessAt: 1, notVisible: ["ABC-12"] })).toMatch(
      /1 ticket not visible with this key: ABC-12$/
    );
  });

  it("prefers the error, then the last check time", () => {
    expect(describeStatus({ error: "No API key on this device", lastSuccessAt: 5 })).toBe(
      "Last error: No API key on this device"
    );
    expect(describeStatus({ lastSuccessAt: 0 })).toBe("Not checked yet");
    expect(describeStatus({ lastSuccessAt: Date.UTC(2026, 10, 4, 9) })).toMatch(/^Last checked /);
  });
});
