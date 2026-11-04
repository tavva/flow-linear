// ABOUTME: Modal for "Add Linear ticket to Focus": paste a URL, then confirm wording and sphere.
// ABOUTME: All refusals show inline; nothing is saved until Add succeeds.

import { App, Modal, Setting } from "obsidian";
import { AddTicket, FoundTicket } from "./add-ticket";

export class AddTicketModal extends Modal {
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private addTicket: AddTicket,
    private getSpheres: () => string[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Add Linear ticket to Focus");
    this.showUrlStep();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private showUrlStep(): void {
    this.contentEl.empty();
    let url = "";
    const lookUp = async () => {
      this.showError("");
      const result = await this.addTicket.lookUp(url);
      if (result.ok) this.showDetailsStep(result.found);
      else this.showError(result.error);
    };

    new Setting(this.contentEl).setName("Ticket link").addText((text) => {
      text.setPlaceholder("https://linear.app/team/issue/ABC-123").onChange((value) => {
        url = value;
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void lookUp();
        }
      });
      text.inputEl.focus();
    });
    this.addErrorEl();
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Find ticket")
        .setCta()
        .onClick(() => void lookUp())
    );
  }

  private showDetailsStep(found: FoundTicket): void {
    this.contentEl.empty();
    let wording = found.ticket.title;
    const spheres = this.getSpheres();
    let sphere = spheres.includes(found.workspace.defaultSphere)
      ? found.workspace.defaultSphere
      : (spheres[0] ?? found.workspace.defaultSphere);

    const add = async () => {
      this.showError("");
      const error = await this.addTicket.add(found, wording, sphere);
      if (error) this.showError(error);
      else this.close();
    };

    this.contentEl.createEl("p", {
      cls: "flow-linear-ticket",
      text: `${found.workspace.displayName} ${found.ticket.identifier}`,
    });
    new Setting(this.contentEl).setName("Wording").addText((text) => {
      text.setValue(wording).onChange((value) => {
        wording = value;
      });
      text.inputEl.addClass("flow-linear-wording");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void add();
        }
      });
      text.inputEl.focus();
    });
    new Setting(this.contentEl).setName("Sphere").addDropdown((dropdown) => {
      for (const option of new Set([...spheres, sphere])) {
        if (option) dropdown.addOption(option, option);
      }
      dropdown.setValue(sphere).onChange((value) => {
        sphere = value;
      });
    });
    this.addErrorEl();
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Add")
        .setCta()
        .onClick(() => void add())
    );
  }

  private addErrorEl(): void {
    this.errorEl = this.contentEl.createDiv({ cls: "flow-linear-error" });
  }

  private showError(message: string): void {
    this.errorEl?.setText(message);
  }
}
