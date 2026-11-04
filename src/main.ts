// ABOUTME: Flow Linear plugin entry point: finds Flow's Focus API and keeps label syncs running.
// ABOUTME: Wires the settings tab, the add-ticket command, change events and the check interval.

import { Events, Notice, Plugin } from "obsidian";
import { AddTicket } from "./add-ticket";
import { AddTicketModal } from "./add-ticket-modal";
import {
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

  async onload(): Promise<void> {
    this.data = readStoredData(await this.loadData());
    this.settings = this.data.settings;
    this.runner = new SyncRunner({
      getFlowApi: () => this.flowApi,
      getData: () => this.data,
      saveData: () => this.saveData(this.data),
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
      notify: (message) => new Notice(message),
      schedule: (callback, delayMs) => {
        const id = window.setTimeout(() => {
          this.timers.delete(id);
          callback();
        }, delayMs);
        this.timers.add(id);
      },
    });

    this.addSettingTab(new FlowLinearSettingTab(this.app, this));

    const addTicket = new AddTicket({
      getFlowApi: () => this.flowApi,
      getData: () => this.data,
      saveData: () => this.saveData(this.data),
      getSecret: (name) => this.getSecret(name),
      createClient: (apiKey) => this.createClient(apiKey),
      requestSync: () => this.requestSync(),
    });
    this.addCommand({
      id: "add-ticket-to-focus",
      name: "Add Linear ticket to Focus",
      callback: () => {
        const api = this.flowApi;
        if (!api) {
          new Notice("Flow isn't enabled");
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
    this.app.workspace.onLayoutReady(() => this.connect(findFlowApi(this.app)));

    this.restartCheckInterval();
  }

  onunload(): void {
    this.disconnect();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }

  getSecret(name: string): string | null {
    if (name === "") return null;
    return this.app.secretStorage.getSecret(name);
  }

  createClient(apiKey: string): LinearWorkspaceClient {
    return new LinearClient(apiKey);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  requestSync(): void {
    if (!this.flowApi) return;
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
    this.requestSync();
  }

  private disconnect(): void {
    this.unsubscribeFromFocus?.();
    this.unsubscribeFromFocus = null;
    this.flowApi = null;
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
