// ABOUTME: Flow Linear plugin entry point: finds Flow's Focus API and keeps label syncs running.
// ABOUTME: Wires the settings tab, the add-ticket command, change events and the check interval.

import { Events, Notice, Plugin } from "obsidian";
import { AddTicket } from "./add-ticket";
import { AddTicketModal } from "./add-ticket-modal";
import {
  findFlow,
  findFlowApi,
  FLOW_API_READY_EVENT,
  FLOW_API_UNLOADED_EVENT,
  FlowApi,
  SOURCE_NAME,
  SUPPORTED_API_VERSION,
} from "./flow-api";
import { LinearClient, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearData, FlowLinearSettings, readStoredData } from "./settings";
import { FlowLinearSettingTab } from "./settings-tab";
import { SyncRunner } from "./sync-runner";

// Focus changes arrive in bursts; wait for them to settle before syncing
const CHANGE_SYNC_DELAY_MS = 2000;

// After connecting to Flow, give the vault's sync time to bring in other devices' changes
// before the first check, so a device waking with an old focus file doesn't act on it
export const STARTUP_SYNC_DELAY_MS = 30_000;

const SEEN_UNFINISHED_KEY = "flow-linear-seen-unfinished";

export const FLOW_WITHOUT_API_NOTICE =
  "This version of Flow is too old for Flow Linear, so Flow Linear won't sync. Update Flow on every device that syncs this vault.";

export default class FlowLinearPlugin extends Plugin {
  data: FlowLinearData = readStoredData(null);
  settings: FlowLinearSettings = this.data.settings; // Same object as data.settings
  flowApi: FlowApi | null = null;
  runner!: SyncRunner;
  private unsubscribeFromFocus: (() => void) | null = null;
  private checkInterval: number | null = null;
  private changeTimer: number | null = null;
  private timers = new Set<number>();
  private warnedAboutVersion = false;
  private startupTimer: number | null = null;
  private syncAllowed = false;
  private settingsGeneration = 0;

  async onload(): Promise<void> {
    this.data = readStoredData(await this.loadData());
    this.settings = this.data.settings;
    this.runner = new SyncRunner({
      getFlowApi: () => this.flowApi,
      getData: () => this.data,
      saveData: () => this.saveData(this.data),
      getSettingsGeneration: () => this.settingsGeneration,
      loadLocal: (): unknown => this.app.loadLocalStorage(SEEN_UNFINISHED_KEY) as unknown,
      saveLocal: (value) => this.app.saveLocalStorage(SEEN_UNFINISHED_KEY, value),
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
      notify: (message) => new Notice(message),
      schedule: (callback, delayMs) => this.schedule(callback, delayMs),
    });

    this.addSettingTab(new FlowLinearSettingTab(this.app, this));

    const addTicket = new AddTicket({
      getFlowApi: () => this.flowApi,
      getData: () => this.data,
      saveData: () => this.saveData(this.data),
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
      requestSync: () => this.requestSync(),
      markSeenUnfinished: (key) => this.runner.markSeenUnfinished(key),
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

    this.restartCheckInterval();
  }

  onunload(): void {
    this.runner.stop();
    this.disconnect();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }

  getSecret(name: string): string | null {
    if (name === "") return null;
    return this.app.secretStorage.getSecret(name);
  }

  /** data.json changed on disk, as when Obsidian Sync brings another device's records. */
  async onExternalSettingsChange(): Promise<void> {
    const data = readStoredData(await this.loadData());
    // Replace contents rather than objects, so the settings tab and a running sync see them
    Object.assign(this.data.settings, data.settings);
    for (const key of Object.keys(this.data.tickets)) delete this.data.tickets[key];
    Object.assign(this.data.tickets, data.tickets);
    this.bumpSettingsGeneration();
    this.restartCheckInterval();
    this.requestSync();
  }

  /** Records written before this call are stale; a sync pass running now must not save them. */
  bumpSettingsGeneration(): void {
    this.settingsGeneration++;
  }

  /**
   * Change the label name. Tracked tickets keep the old name in their record until a sync
   * takes the old label off; then the new label goes on those with unfinished items.
   */
  async renameLabel(name: string): Promise<void> {
    const oldName = this.settings.labelName;
    if (name === oldName) return;
    for (const record of Object.values(this.data.tickets)) record.labelName ??= oldName;
    this.settings.labelName = name;
    this.bumpSettingsGeneration();
    await this.saveSettings();
    this.requestSync();
  }

  /** Run a callback later; cancelled if the plugin unloads first. */
  schedule(callback: () => void, delayMs: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, delayMs);
    this.timers.add(id);
  }

  createClient(apiKey: string): LinearWorkspaceClient {
    return new LinearClient(apiKey);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  requestSync(): void {
    if (!this.flowApi || !this.syncAllowed) return;
    this.runner.requestSync().catch((error) => console.error("Flow Linear sync failed", error));
  }

  restartCheckInterval(): void {
    if (this.checkInterval !== null) window.clearInterval(this.checkInterval);
    this.checkInterval = window.setInterval(
      () => this.requestSync(),
      this.settings.checkIntervalMinutes * 60_000
    );
    this.registerInterval(this.checkInterval);
  }

  /** Connect to Flow as it is now, warning if it's a version without the Focus API. */
  private connectToInstalledFlow(): void {
    const lookup = findFlow(this.app);
    if (lookup.status === "no-api") {
      // Flow 1.3.12 and earlier also remove external Focus items; nothing here can sync safely
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
    this.unsubscribeFromFocus = api.onFocusChange(SOURCE_NAME, () => this.requestSyncSoon());
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      this.syncAllowed = true;
      this.requestSync();
    }, STARTUP_SYNC_DELAY_MS);
  }

  private disconnect(): void {
    this.unsubscribeFromFocus?.();
    this.unsubscribeFromFocus = null;
    this.flowApi = null;
    this.syncAllowed = false;
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.changeTimer !== null) {
      window.clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
  }

  private requestSyncSoon(): void {
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = null;
      this.requestSync();
    }, CHANGE_SYNC_DELAY_MS);
  }
}
