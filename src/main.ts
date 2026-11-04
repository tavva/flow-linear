// ABOUTME: Flow Linear plugin entry point: finds Flow's Focus API and runs the completion checks.
// ABOUTME: Wires the settings tab, the add-ticket command and the check interval.

import { Events, Notice, Plugin } from "obsidian";
import { AddTicket } from "./add-ticket";
import { AddTicketModal } from "./add-ticket-modal";
import { CompletionChecker } from "./completion";
import {
  findFlow,
  findFlowApi,
  FLOW_API_READY_EVENT,
  FLOW_API_UNLOADED_EVENT,
  FlowApi,
  SUPPORTED_API_VERSION,
} from "./flow-api";
import { LinearClient, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearSettings, readSettings } from "./settings";
import { FlowLinearSettingTab } from "./settings-tab";

// After connecting to Flow, give the vault's sync time to bring in other devices' changes
// before the first check
export const STARTUP_CHECK_DELAY_MS = 30_000;

// One timer, registered once, ticks this often and checks when the interval has passed, so
// changing the interval needs no new timer
export const TICK_MS = 60_000;

export const FLOW_WITHOUT_API_NOTICE =
  "This version of Flow is too old for Flow Linear, so Flow Linear won't run. Update Flow on every device that syncs this vault.";

export default class FlowLinearPlugin extends Plugin {
  settings: FlowLinearSettings = readSettings(null);
  flowApi: FlowApi | null = null;
  checker!: CompletionChecker;
  private settingTab: FlowLinearSettingTab | null = null;
  private lastCheckRequestedAt = 0;
  private startupTimer: number | null = null;
  private checksAllowed = false;
  private warnedAboutVersion = false;

  async onload(): Promise<void> {
    this.settings = readSettings(await this.loadData());
    this.checker = new CompletionChecker({
      getFlowApi: () => this.flowApi,
      getSettings: () => this.settings,
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
      notify: (message) => new Notice(message),
    });

    this.settingTab = new FlowLinearSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    const addTicket = new AddTicket({
      getFlowApi: () => this.flowApi,
      getSettings: () => this.settings,
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
    });
    this.addCommand({
      id: "add-ticket-to-focus",
      name: "Add Linear ticket to Focus",
      callback: () => {
        const api = this.flowApi;
        if (!api) {
          const tooOld = findFlow(this.app).status === "no-api";
          new Notice(tooOld ? FLOW_WITHOUT_API_NOTICE : "Flow isn't enabled");
          return;
        }
        new AddTicketModal(this.app, addTicket, () => api.getSpheres()).open();
      },
    });

    // Flow's own events aren't in the workspace's typed overloads
    const workspaceEvents: Events = this.app.workspace;
    this.registerEvent(
      workspaceEvents.on(FLOW_API_READY_EVENT, (api: unknown) => {
        this.connect((api as FlowApi | undefined) ?? findFlowApi(this.app));
      })
    );
    this.registerEvent(workspaceEvents.on(FLOW_API_UNLOADED_EVENT, () => this.disconnect()));
    this.app.workspace.onLayoutReady(() => this.connectToInstalledFlow());

    this.registerInterval(window.setInterval(() => this.checkIfDue(), TICK_MS));
  }

  onunload(): void {
    this.checker.stop();
    this.disconnect();
  }

  getSecret(name: string): string | null {
    if (name === "") return null;
    return this.app.secretStorage.getSecret(name);
  }

  /** data.json changed on disk, as when the vault's sync brings another device's settings. */
  async onExternalSettingsChange(): Promise<void> {
    // Replace contents rather than the object, so the settings tab and a running check see them
    Object.assign(this.settings, readSettings(await this.loadData()));
    this.settingTab?.update();
    this.requestCheck();
  }

  createClient(apiKey: string): LinearWorkspaceClient {
    return new LinearClient(apiKey);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  requestCheck(): void {
    if (!this.flowApi || !this.checksAllowed) return;
    this.lastCheckRequestedAt = Date.now();
    this.checker.requestCheck().catch((error) => console.error("Flow Linear check failed", error));
  }

  private checkIfDue(): void {
    const intervalMs = this.settings.checkIntervalMinutes * 60_000;
    if (Date.now() - this.lastCheckRequestedAt >= intervalMs) this.requestCheck();
  }

  /** Connect to Flow as it is now, warning if it's a version without the Focus API. */
  private connectToInstalledFlow(): void {
    const lookup = findFlow(this.app);
    if (lookup.status === "no-api") {
      // Flow 1.3.12 and earlier also remove external Focus items
      new Notice(FLOW_WITHOUT_API_NOTICE, 0);
      return;
    }
    if (lookup.status === "found") this.connect(lookup.api);
  }

  private connect(api: FlowApi | null): void {
    if (!api || api === this.flowApi) return;
    this.disconnect();
    if (api.apiVersion !== SUPPORTED_API_VERSION) {
      if (!this.warnedAboutVersion) {
        this.warnedAboutVersion = true;
        new Notice("This version of Flow isn't supported by Flow Linear. Update both plugins.");
      }
      return;
    }
    this.flowApi = api;
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      this.checksAllowed = true;
      this.requestCheck();
    }, STARTUP_CHECK_DELAY_MS);
  }

  private disconnect(): void {
    this.flowApi = null;
    this.checksAllowed = false;
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }
}
