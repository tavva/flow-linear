// ABOUTME: A sync runner wired to an in-memory Focus list, Linear workspaces and a fake clock.
// ABOUTME: One Harness is one device; several can share Linear workspaces to model multi-device use.

import { FlowApi } from "../../src/flow-api";
import { FlowLinearData, readStoredData, WorkspaceSettings } from "../../src/settings";
import { SyncRunner } from "../../src/sync-runner";
import { workspace } from "./builders";
import { FocusStore } from "./focus-store";
import { LinearWorkspace } from "./linear-workspace";

export const CONFIRM_MS = 30_000;

export class Harness {
  focus = new FocusStore();
  linear: Map<string, LinearWorkspace>;
  data: FlowLinearData = readStoredData(null);
  secrets = new Map<string, string>([["linear-testco", "linear-testco"]]);
  local: unknown = null; // This device's local storage
  notices: string[] = [];
  scheduled: { callback: () => void; delayMs: number }[] = [];
  saves = 0;
  generation = 0;
  clock: { now: number };
  flow: FlowApi | null = this.focus;
  runner: SyncRunner;

  constructor(
    workspaces: WorkspaceSettings[] = [workspace()],
    options: { linear?: Map<string, LinearWorkspace>; clock?: { now: number } } = {}
  ) {
    this.linear = options.linear ?? new Map([["linear-testco", new LinearWorkspace()]]);
    this.clock = options.clock ?? { now: 1_000_000 };
    this.data.settings.workspaces = workspaces;
    this.runner = this.makeRunner();
  }

  /** A fresh runner, as after Obsidian restarts: in-memory state goes, local storage stays. */
  restart(): void {
    this.runner = this.makeRunner();
  }

  private makeRunner(): SyncRunner {
    return new SyncRunner({
      getFlowApi: () => this.flow,
      getData: () => this.data,
      saveData: async () => {
        this.saves++;
      },
      getSettingsGeneration: () => this.generation,
      loadLocal: () => structuredClone(this.local),
      saveLocal: (value) => {
        this.local = structuredClone(value);
      },
      getSecret: (name) => this.secrets.get(name) ?? null,
      // Each API key opens its own in-memory workspace
      createClient: (apiKey) => {
        const client = this.linear.get(apiKey);
        if (!client) throw new Error(`No workspace for key ${apiKey}`);
        return client;
      },
      notify: (message) => this.notices.push(message),
      schedule: (callback, delayMs) => this.scheduled.push({ callback, delayMs }),
      now: () => this.clock.now,
      confirmDelayMs: CONFIRM_MS,
    });
  }

  get testco(): LinearWorkspace {
    return this.linear.get("linear-testco") as LinearWorkspace;
  }

  sync(): Promise<void> {
    return this.runner.requestSync();
  }

  /** Let time pass and run the sync the runner scheduled to confirm changes. */
  async passTime(ms: number): Promise<void> {
    this.clock.now += ms;
    // Stands in for the scheduled callback, which requests one sync
    this.scheduled = this.scheduled.filter((entry) => entry.delayMs > ms);
    await this.runner.requestSync();
  }

  /** Sync, then sync again once anything awaited is confirmed. */
  async settle(): Promise<void> {
    await this.sync();
    await this.passTime(CONFIRM_MS);
  }
}
