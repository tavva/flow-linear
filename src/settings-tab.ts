// ABOUTME: Flow Linear's settings tab, built from declarative setting definitions.
// ABOUTME: Lists workspaces, holds the label name and check interval, and shows each workspace's status.

import { App, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type FlowLinearPlugin from "./main";
import { clampInterval, DEFAULT_LABEL_NAME, MIN_CHECK_INTERVAL_MINUTES } from "./settings";
import { WorkspaceStatus } from "./sync-runner";
import { WorkspaceModal } from "./workspace-modal";

export function describeStatus(status: WorkspaceStatus): string {
  if (status.error) return `Last error: ${status.error}`;
  if (status.lastSuccessAt) {
    return `Last checked ${new Date(status.lastSuccessAt).toLocaleString()}`;
  }
  return "Not checked yet";
}

export class FlowLinearSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: FlowLinearPlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { workspaces } = this.plugin.settings;
    return [
      {
        type: "list",
        heading: "Workspaces",
        emptyState: "No Linear workspaces yet.",
        addItem: { name: "Add workspace", action: () => this.openWorkspaceModal() },
        onDelete: (index) => {
          workspaces.splice(index, 1);
          void this.plugin.saveSettings().then(() => this.update());
        },
        items: workspaces.map((workspace) => ({
          name: workspace.displayName,
          desc: `${workspace.urlKey} · default sphere: ${workspace.defaultSphere || "Flow's first sphere"}`,
        })),
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Label name",
            desc: "The Linear label that marks tickets in Focus. The same name is used in every workspace.",
            control: {
              type: "text",
              key: "labelName",
              placeholder: DEFAULT_LABEL_NAME,
              validate: (value) => (value.trim() === "" ? "Enter a label name." : undefined),
            },
          },
          {
            name: "Check every",
            desc: "Minutes between checks with Linear.",
            control: {
              type: "number",
              key: "checkIntervalMinutes",
              min: MIN_CHECK_INTERVAL_MINUTES,
              step: 1,
              validate: (value) =>
                value >= MIN_CHECK_INTERVAL_MINUTES ? undefined : "Check at least once a minute.",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Status",
        visible: workspaces.length > 0,
        items: workspaces.map((workspace) => ({
          name: workspace.displayName,
          desc: describeStatus(this.plugin.runner.getStatus(workspace.urlKey)),
        })),
      },
    ];
  }

  getControlValue(key: string): unknown {
    const { settings } = this.plugin;
    if (key === "labelName") return settings.labelName;
    if (key === "checkIntervalMinutes") return settings.checkIntervalMinutes;
    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    if (key === "labelName" && typeof value === "string" && value.trim() !== "") {
      settings.labelName = value.trim();
    } else if (key === "checkIntervalMinutes" && typeof value === "number") {
      settings.checkIntervalMinutes = clampInterval(value);
      this.plugin.restartCheckInterval();
    } else {
      return;
    }
    await this.plugin.saveSettings();
  }

  private openWorkspaceModal(): void {
    new WorkspaceModal(this.app, {
      existing: this.plugin.settings.workspaces,
      spheres: this.plugin.flowApi?.getSpheres() ?? [],
      getSecret: (name) => this.plugin.getSecret(name),
      createClient: (apiKey) => this.plugin.createClient(apiKey),
      onSave: async (workspace) => {
        this.plugin.settings.workspaces.push(workspace);
        await this.plugin.saveSettings();
        this.update();
        this.plugin.requestSync();
      },
    }).open();
  }
}
