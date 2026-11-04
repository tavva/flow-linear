// ABOUTME: Runs label syncs: fetches Linear and Focus state, decides actions, and carries them out.
// ABOUTME: Runs one sync at a time, queues a single follow-up, and keeps per-workspace status.

import { FlowApi, SOURCE_NAME, ExternalFocusItem } from "./flow-api";
import { LinearError, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearData, TicketRecord, WorkspaceSettings } from "./settings";
import { decideSyncActions, itemTicketKey, SyncAction } from "./sync-decisions";

// How long Focus must keep lacking a ticket's items before its label comes off. Covers sync
// glitches that briefly empty the focus file, and older Flow versions that drop external items.
export const REMOVAL_CONFIRM_DELAY_MS = 30_000;

export interface WorkspaceStatus {
  lastSuccessAt?: number;
  error?: string;
}

export interface SyncRunnerDeps {
  getFlowApi(): FlowApi | null;
  getData(): FlowLinearData;
  saveData(): Promise<void>;
  getSecret(name: string): string | null;
  createClient(apiKey: string): LinearWorkspaceClient;
  notify(message: string): void;
  // Run a callback later; used to come back and confirm a label removal
  schedule(callback: () => void, delayMs: number): void;
  now?: () => number;
  removalConfirmDelayMs?: number;
}

export const NO_KEY_STATUS = "No API key on this device";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SyncRunner {
  private running: Promise<void> | null = null;
  private queued = false;
  private statuses = new Map<string, WorkspaceStatus>();
  private notified = new Set<string>();
  private refusedKeys = new Map<string, string>(); // urlKey → the API key Linear refused
  private rateLimitedUntil = new Map<string, number>();
  private labelIds = new Map<string, string>(); // "<urlKey>\n<label name>" → label id
  private removalCandidates = new Map<string, number>(); // ticket key → first seen
  private now: () => number;
  private confirmDelayMs: number;

  constructor(private deps: SyncRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.confirmDelayMs = deps.removalConfirmDelayMs ?? REMOVAL_CONFIRM_DELAY_MS;
  }

  /** Start a sync, or queue one follow-up if a sync is running. Resolves when both are done. */
  requestSync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.runUntilSettled().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  getStatus(urlKey: string): WorkspaceStatus {
    return this.statuses.get(urlKey) ?? {};
  }

  private async runUntilSettled(): Promise<void> {
    do {
      this.queued = false;
      await this.runOnce();
    } while (this.queued);
  }

  private async runOnce(): Promise<void> {
    const api = this.deps.getFlowApi();
    if (!api) return;
    for (const workspace of this.deps.getData().settings.workspaces) {
      await this.syncWorkspace(api, workspace);
    }
  }

  private async syncWorkspace(api: FlowApi, workspace: WorkspaceSettings): Promise<void> {
    const { urlKey } = workspace;
    const apiKey = this.deps.getSecret(workspace.apiKeySecretName);
    if (!apiKey) {
      this.statuses.set(urlKey, { ...this.getStatus(urlKey), error: NO_KEY_STATUS });
      return;
    }
    if (this.refusedKeys.get(urlKey) === apiKey) return;
    if ((this.rateLimitedUntil.get(urlKey) ?? 0) > this.now()) return;

    try {
      const client = this.deps.createClient(apiKey);
      const awaiting = await this.syncWithClient(api, workspace, client);
      this.updateRemovalCandidates(urlKey, awaiting);
      this.refusedKeys.delete(urlKey);
      this.statuses.set(urlKey, { lastSuccessAt: this.now() });
    } catch (error) {
      this.handleError(workspace, apiKey, error);
    }
  }

  /** Returns the ticket keys whose label removal still waits for confirmation. */
  private async syncWithClient(
    api: FlowApi,
    workspace: WorkspaceSettings,
    client: LinearWorkspaceClient
  ): Promise<string[]> {
    const data = this.deps.getData();
    const { labelName } = data.settings;
    const prefix = `${workspace.urlKey}/`;
    const records = Object.fromEntries(
      Object.entries(data.tickets).filter(([key]) => key.startsWith(prefix))
    );
    const focusItems = (await api.getFocusItems(SOURCE_NAME)).filter((item) =>
      itemTicketKey(item)?.startsWith(prefix)
    );
    const untrackedIdentifiers = [
      ...new Set(
        focusItems
          .map((item) => itemTicketKey(item) as string)
          .filter((key) => !records[key])
          .map((key) => key.slice(prefix.length))
      ),
    ];

    const labelledTickets = await client.getLabelledTickets(labelName);
    const trackedTickets = [
      ...(await client.getTicketsByIds(Object.values(records).map((r) => r.issueId))),
      ...(await client.getTicketsByIdentifiers(untrackedIdentifiers)),
    ];

    const cutoff = this.now() - this.confirmDelayMs;
    const confirmedRemovals = new Set(
      [...this.removalCandidates].filter(([, seen]) => seen <= cutoff).map(([key]) => key)
    );

    const actions = decideSyncActions({
      workspace,
      labelName,
      labelledTickets,
      trackedTickets,
      records,
      focusItems,
      confirmedRemovals,
    });

    const awaiting: string[] = [];
    for (const action of actions) {
      if (action.type === "awaitRemoval") {
        awaiting.push(action.ticketKey);
        continue;
      }
      await this.carryOut(action, api, workspace, client);
    }
    return awaiting;
  }

  private updateRemovalCandidates(urlKey: string, awaiting: string[]): void {
    const prefix = `${urlKey}/`;
    for (const key of [...this.removalCandidates.keys()]) {
      if (key.startsWith(prefix) && !awaiting.includes(key)) this.removalCandidates.delete(key);
    }
    for (const key of awaiting) {
      if (!this.removalCandidates.has(key)) this.removalCandidates.set(key, this.now());
    }
    if (awaiting.length > 0) {
      this.deps.schedule(() => {
        this.requestSync().catch((error) => console.error("Flow Linear sync failed", error));
      }, this.confirmDelayMs);
    }
  }

  private async carryOut(
    action: Exclude<SyncAction, { type: "awaitRemoval" }>,
    api: FlowApi,
    workspace: WorkspaceSettings,
    client: LinearWorkspaceClient
  ): Promise<void> {
    switch (action.type) {
      case "import":
        await this.importTicket(action, api, workspace);
        break;
      case "completeItems":
        await this.applyToItems(api, action.itemIds, (id) => api.completeFocusItem(id));
        break;
      case "removeItems":
        await this.applyToItems(api, action.itemIds, (id) => api.removeFocusItem(id));
        await this.setRecord(action.ticketKey, null);
        break;
      case "addLabel": {
        const labelId = await this.labelId(workspace, client);
        await client.addLabel(action.issueId, labelId);
        await this.setRecord(action.ticketKey, { issueId: action.issueId, label: "synced" });
        break;
      }
      case "removeLabel": {
        // Recorded first, so a failed removal is retried without waiting for confirmation again
        await this.setRecord(action.ticketKey, {
          issueId: action.issueId,
          label: "remove-pending",
        });
        const labelId = await this.labelId(workspace, client);
        await client.removeLabel(action.issueId, labelId);
        await this.setRecord(action.ticketKey, null);
        break;
      }
      case "setRecord":
        await this.setRecord(action.ticketKey, action.record);
        break;
    }
  }

  private async importTicket(
    action: Extract<SyncAction, { type: "import" }>,
    api: FlowApi,
    workspace: WorkspaceSettings
  ): Promise<void> {
    // Another device may have imported it since this sync read Focus
    const current = await api.getFocusItems(SOURCE_NAME);
    const alreadyThere = current.some(
      (item) => item.completedAt === undefined && itemTicketKey(item) === action.ticketKey
    );
    if (!alreadyThere) {
      const sphere = workspace.defaultSphere || api.getSpheres()[0];
      if (!sphere) throw new Error("No sphere to add Linear tickets to; set one in settings");
      await api.addFocusItem({
        text: action.ticket.title,
        sphere,
        sourceName: SOURCE_NAME,
        sourceLabel: workspace.displayName,
        url: action.ticket.url,
        externalId: action.ticket.identifier,
      });
    }
    await this.setRecord(action.ticketKey, { issueId: action.ticket.id, label: "synced" });
  }

  /**
   * Apply a change to each item. A change that fails because the item has already gone (or,
   * for completion, is already complete) counts as done; other failures are thrown.
   */
  private async applyToItems(
    api: FlowApi,
    itemIds: string[],
    change: (id: string) => Promise<void>
  ): Promise<void> {
    for (const id of itemIds) {
      try {
        await change(id);
      } catch (error) {
        const current: ExternalFocusItem[] = await api.getFocusItems(SOURCE_NAME);
        const item = current.find((entry) => entry.id === id);
        if (item && item.completedAt === undefined) throw error;
      }
    }
  }

  private async labelId(workspace: WorkspaceSettings, client: LinearWorkspaceClient) {
    const { labelName } = this.deps.getData().settings;
    const cacheKey = `${workspace.urlKey}\n${labelName.toLowerCase()}`;
    let id = this.labelIds.get(cacheKey);
    if (!id) {
      id =
        (await client.findWorkspaceLabel(labelName)) ??
        (await client.createWorkspaceLabel(labelName));
      this.labelIds.set(cacheKey, id);
    }
    return id;
  }

  private async setRecord(key: string, record: TicketRecord | null): Promise<void> {
    const { tickets } = this.deps.getData();
    if (record) tickets[key] = record;
    else delete tickets[key];
    await this.deps.saveData();
  }

  private handleError(workspace: WorkspaceSettings, apiKey: string, error: unknown): void {
    const { urlKey, displayName } = workspace;
    const message = errorMessage(error);
    this.statuses.set(urlKey, { ...this.getStatus(urlKey), error: message });

    if (!(error instanceof LinearError)) {
      console.error(`Flow Linear sync failed for ${displayName}`, error);
      this.notifyOnce(urlKey, `Flow Linear couldn't sync ${displayName}: ${message}`);
      return;
    }
    switch (error.kind) {
      case "auth":
        this.refusedKeys.set(urlKey, apiKey);
        this.notifyOnce(
          urlKey,
          `Linear refused the API key for ${displayName}. Check it in Flow Linear's settings.`
        );
        break;
      case "rate-limit": {
        const minutes = this.deps.getData().settings.checkIntervalMinutes;
        this.rateLimitedUntil.set(urlKey, this.now() + minutes * 60_000);
        break;
      }
      case "network":
      case "api":
        this.notifyOnce(urlKey, `Couldn't reach Linear for ${displayName}`);
        break;
    }
  }

  private notifyOnce(urlKey: string, message: string): void {
    if (this.notified.has(urlKey)) return;
    this.notified.add(urlKey);
    this.deps.notify(message);
  }
}
