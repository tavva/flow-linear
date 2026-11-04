// ABOUTME: Flow Linear's settings tab, built from declarative setting definitions.
// ABOUTME: Lists workspaces, holds the check interval, and shows each workspace's status.

import { App, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type FlowLinearPlugin from "./main";
import { notVisibleMessage, WorkspaceStatus } from "./completion";
import {
  clampInterval,
  MIN_CHECK_INTERVAL_MINUTES,
  secretNameFor,
  WorkspaceSettings,
} from "./settings";
import { ApiKeyModal, WorkspaceModal } from "./workspace-modal";

export const OLD_FLOW_WARNING =
  "If any device that syncs this vault runs Flow 1.3.12 or earlier, it will delete your Linear items from Focus, and that deletion syncs to every device. Update Flow on every device before using Flow Linear.";

export function describeStatus(status: WorkspaceStatus): string {
  if (status.error) return `Last error: ${status.error}`;
  if (!status.lastSuccessAt) return "Not checked yet";
  const checked = `Last checked ${new Date(status.lastSuccessAt).toLocaleString()}`;
  return status.notVisible?.length
    ? `${checked}. ${notVisibleMessage(status.notVisible)}`
    : checked;
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
        type: "group",
        cls: "flow-linear-warning",
        visible: !this.plugin.settings.oldFlowWarningDismissed,
        items: [
          {
            name: "Update Flow on every device first",
            desc: OLD_FLOW_WARNING,
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Dismiss").onClick(() => void this.dismissOldFlowWarning())
              );
            },
          },
        ],
      },
      {
        type: "list",
        heading: "Workspaces",
        emptyState: "No Linear workspaces yet.",
        addItem: { name: "Add workspace", action: () => this.openWorkspaceModal() },
        onDelete: (index) => void this.deleteWorkspace(index),
        items: workspaces.map((workspace) => ({
          name: workspace.displayName,
          desc: `${workspace.urlKey} · default sphere: ${workspace.defaultSphere || "Flow's first sphere"}`,
          render: (setting) => {
            setting.addButton((button) =>
              button.setButtonText("Change key").onClick(() => this.openApiKeyModal(workspace))
            );
          },
        })),
      },
      {
        type: "group",
        heading: "Checking Linear",
        items: [
          {
            name: "Check every",
            desc: "Minutes between checks for tickets that are done, so their Focus items can be completed.",
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
          desc: describeStatus(this.plugin.checker.getStatus(workspace.urlKey)),
        })),
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "checkIntervalMinutes") return this.plugin.settings.checkIntervalMinutes;
    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== "checkIntervalMinutes" || typeof value !== "number") return;
    // The plugin's timer reads the interval on each tick
    this.plugin.settings.checkIntervalMinutes = clampInterval(value);
    await this.plugin.saveSettings();
  }

  // Reads the list at the time of the click, not when the tab was drawn
  private async deleteWorkspace(index: number): Promise<void> {
    const [removed] = this.plugin.settings.workspaces.splice(index, 1);
    // A workspace set up with Obsidian's secret picker may name a secret other plugins share,
    // so only a secret this plugin named itself is cleared
    if (removed && removed.apiKeySecretName === secretNameFor(removed.urlKey)) {
      this.plugin.clearSecret(removed.apiKeySecretName);
    }
    await this.plugin.saveSettings();
    this.update();
  }

  private async dismissOldFlowWarning(): Promise<void> {
    this.plugin.settings.oldFlowWarningDismissed = true;
    await this.plugin.saveSettings();
    this.update();
  }

  private openWorkspaceModal(): void {
    new WorkspaceModal(this.app, {
      existing: this.plugin.settings.workspaces,
      spheres: this.plugin.flowApi?.getSpheres() ?? [],
      createClient: (apiKey) => this.plugin.createClient(apiKey),
      onSave: async (workspace, apiKey) => {
        this.plugin.storeSecret(workspace.apiKeySecretName, apiKey);
        this.plugin.settings.workspaces.push(workspace);
        await this.plugin.saveSettings();
        this.update();
        this.plugin.requestCheck();
      },
    }).open();
  }

  private openApiKeyModal(workspace: WorkspaceSettings): void {
    new ApiKeyModal(this.app, {
      workspace,
      createClient: (apiKey) => this.plugin.createClient(apiKey),
      onSave: async (apiKey) => {
        // Always the plugin's own name, never a secret picked earlier that others may share
        const name = secretNameFor(workspace.urlKey);
        this.plugin.storeSecret(name, apiKey);
        workspace.apiKeySecretName = name;
        await this.plugin.saveSettings();
        this.update();
        this.plugin.requestCheck();
      },
    }).open();
  }
}
