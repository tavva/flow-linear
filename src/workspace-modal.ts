// ABOUTME: Modal for adding a Linear workspace: pick its API key secret, name and default sphere.
// ABOUTME: Saving checks the key with Linear, which also supplies the workspace's urlKey.

import { App, Modal, SecretComponent, Setting } from "obsidian";
import { checkWorkspace, WorkspaceFormInput } from "./workspace-form";
import { LinearWorkspaceClient } from "./linear-client";
import { WorkspaceSettings } from "./settings";

export interface WorkspaceModalDeps {
  existing: WorkspaceSettings[];
  spheres: string[];
  getSecret(name: string): string | null;
  createClient(apiKey: string): LinearWorkspaceClient;
  onSave(workspace: WorkspaceSettings): Promise<void>;
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
      apiKeySecretName: "",
      displayName: "",
      defaultSphere: this.deps.spheres[0] ?? "",
    };

    new Setting(contentEl)
      .setName("Linear API key")
      .setDesc(
        "A personal API key from Linear's Settings → Security & access, starting lin_api_. Read access is enough. Pick a key you've saved by its name, or create one: the ID is just a name for it, such as linear-acme, and the value is the lin_api_ key itself (ignore Obsidian's example value). Obsidian keeps the key in its secret storage on this device; only the name goes into Flow Linear's synced settings."
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el).onChange((value) => {
          input.apiKeySecretName = value;
        })
      );
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

    const errorEl = contentEl.createDiv({ cls: "flow-linear-error" });
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          errorEl.setText("");
          button.setDisabled(true);
          const result = await checkWorkspace(
            input,
            this.deps.existing,
            (name) => this.deps.getSecret(name),
            (apiKey) => this.deps.createClient(apiKey)
          );
          button.setDisabled(false);
          if (!result.ok) {
            errorEl.setText(result.error);
            return;
          }
          await this.deps.onSave(result.workspace);
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
