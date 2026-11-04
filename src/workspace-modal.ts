// ABOUTME: Modals for adding a Linear workspace and for replacing a workspace's API key.
// ABOUTME: Saving checks the key with Linear, which also supplies a new workspace's urlKey.

import { App, Modal, Setting } from "obsidian";
import { LinearWorkspaceClient } from "./linear-client";
import { WorkspaceSettings } from "./settings";
import { checkReplacementKey, checkWorkspace, WorkspaceFormInput } from "./workspace-form";

export const API_KEY_DESCRIPTION =
  "A personal API key from Linear (Settings → Security & access). Read access is enough. Stored in Obsidian's secret storage on this device only.";

/** A password field for the key; the value stays out of the DOM's visible text. */
function addApiKeyField(containerEl: HTMLElement, onChange: (value: string) => void): void {
  new Setting(containerEl)
    .setName("Linear API key")
    .setDesc(API_KEY_DESCRIPTION)
    .addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text.setPlaceholder("lin_api_…").onChange(onChange);
    });
}

/** A Save button that disables itself while saving and shows any error above it. */
function addSaveButton(containerEl: HTMLElement, save: () => Promise<string | null>): void {
  const errorEl = containerEl.createDiv({ cls: "flow-linear-error" });
  new Setting(containerEl).addButton((button) =>
    button
      .setButtonText("Save")
      .setCta()
      .onClick(async () => {
        errorEl.setText("");
        button.setDisabled(true);
        let error: string | null;
        try {
          error = await save();
        } catch (thrown) {
          // For example SecretStorage refusing the key
          error = `Couldn't save: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
        }
        button.setDisabled(false);
        if (error) errorEl.setText(error);
      })
  );
}

export interface WorkspaceModalDeps {
  existing: WorkspaceSettings[];
  spheres: string[];
  createClient(apiKey: string): LinearWorkspaceClient;
  // Stores the key under the workspace's secret name, then adds the workspace
  onSave(workspace: WorkspaceSettings, apiKey: string): Promise<void>;
}

export class WorkspaceModal extends Modal {
  constructor(
    app: App,
    private deps: WorkspaceModalDeps
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Add Linear workspace");
    const { contentEl } = this;
    const input: WorkspaceFormInput = {
      apiKey: "",
      displayName: "",
      defaultSphere: this.deps.spheres[0] ?? "",
    };

    addApiKeyField(contentEl, (value) => {
      input.apiKey = value;
    });
    new Setting(contentEl)
      .setName("Display name")
      .setDesc("Shown on Focus items. Leave empty to use the workspace's name.")
      .addText((text) =>
        text.onChange((value) => {
          input.displayName = value;
        })
      );
    new Setting(contentEl)
      .setName("Default sphere")
      .setDesc("The sphere new items from this workspace go into.")
      .addDropdown((dropdown) => {
        for (const sphere of this.deps.spheres) dropdown.addOption(sphere, sphere);
        dropdown.setValue(input.defaultSphere).onChange((value) => {
          input.defaultSphere = value;
        });
      });

    addSaveButton(contentEl, async () => {
      const result = await checkWorkspace(input, this.deps.existing, (apiKey) =>
        this.deps.createClient(apiKey)
      );
      if (!result.ok) return result.error;
      await this.deps.onSave(result.workspace, result.apiKey);
      this.close();
      return null;
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ApiKeyModalDeps {
  workspace: WorkspaceSettings;
  createClient(apiKey: string): LinearWorkspaceClient;
  onSave(apiKey: string): Promise<void>;
}

/** Replace an existing workspace's key, or enter it on a device that doesn't have it yet. */
export class ApiKeyModal extends Modal {
  constructor(
    app: App,
    private deps: ApiKeyModalDeps
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`Change Linear API key for ${this.deps.workspace.displayName}`);
    let apiKey = "";
    addApiKeyField(this.contentEl, (value) => {
      apiKey = value;
    });
    addSaveButton(this.contentEl, async () => {
      const result = await checkReplacementKey(apiKey, this.deps.workspace, (key) =>
        this.deps.createClient(key)
      );
      if (!result.ok) return result.error;
      await this.deps.onSave(result.apiKey);
      this.close();
      return null;
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
