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

function splitCandidate(candidate: string): [string, string] {
  const split = candidate.indexOf("\n");
  return [candidate.slice(0, split), candidate.slice(split + 1)];
}

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
  // "<add|remove>\n<ticket key>" → when a pass first awaited that change
  private candidates = new Map<string, number>();
  private stopped = false;
  private now: () => number;
  private confirmDelayMs: number;

  constructor(private deps: SyncRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.confirmDelayMs = deps.removalConfirmDelayMs ?? REMOVAL_CONFIRM_DELAY_MS;
  }

  /** Start a sync, or queue one follow-up if a sync is running. Resolves when both are done. */
  requestSync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.runUntilSettled().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Stop at the next step and start no more runs. Called when the plugin unloads. */
  stop(): void {
    this.stopped = true;
  }

  getStatus(urlKey: string): WorkspaceStatus {
    return this.statuses.get(urlKey) ?? {};
  }

  private async runUntilSettled(): Promise<void> {
    do {
      this.queued = false;
      await this.runOnce();
    } while (this.queued && !this.stopped);
  }

  private async runOnce(): Promise<void> {
    const api = this.deps.getFlowApi();
    if (!api) return;
    // A copy, so removing a workspace mid-run doesn't skip another
    for (const workspace of [...this.deps.getData().settings.workspaces]) {
      if (this.stopped) return;
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
      await this.syncWithClient(api, workspace, client);
      this.refusedKeys.delete(urlKey);
      this.statuses.set(urlKey, { lastSuccessAt: this.now() });
    } catch (error) {
      this.handleError(workspace, apiKey, error);
    }
  }

  private async syncWithClient(
    api: FlowApi,
    workspace: WorkspaceSettings,
    client: LinearWorkspaceClient
  ): Promise<void> {
    const data = this.deps.getData();
    const prefix = `${workspace.urlKey}/`;
    const records = Object.fromEntries(
      Object.entries(data.tickets).filter(([key]) => key.startsWith(prefix))
    );

    let actions: SyncAction[];
    try {
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

      const labelId = await this.findLabelId(workspace, client);
      const labelledTickets = labelId ? await client.getLabelledTickets(labelId) : [];
      const trackedTickets = [
        ...(await client.getTicketsByIds(Object.values(records).map((r) => r.issueId))),
        ...(await client.getTicketsByIdentifiers(untrackedIdentifiers)),
      ];

      actions = decideSyncActions({
        workspace,
        labelId,
        labelledTickets,
        trackedTickets,
        records,
        focusItems,
        confirmedRemovals: this.confirmed(prefix, "remove"),
        confirmedAdds: this.confirmed(prefix, "add"),
      });
    } catch (error) {
      // Nothing was seen this pass, so earlier sightings can't be confirmed by the next one
      this.updateCandidates(prefix, []);
      throw error;
    }

    this.updateCandidates(prefix, actions);

    // Carry on past a failed action so one stuck ticket doesn't hold up the rest, unless
    // Linear itself is out of reach
    let firstError: Error | null = null;
    for (const action of actions) {
      if (this.stopped) break;
      if (action.type === "awaitRemoval" || action.type === "awaitAdd") continue;
      try {
        await this.carryOut(action, api, workspace, client);
      } catch (error) {
        if (error instanceof LinearError && error.kind !== "api") throw error;
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (firstError !== null) throw firstError;
  }

  private confirmed(prefix: string, kind: "add" | "remove"): Set<string> {
    const cutoff = this.now() - this.confirmDelayMs;
    const confirmed = new Set<string>();
    for (const [candidate, seen] of this.candidates) {
      const [candidateKind, key] = splitCandidate(candidate);
      if (candidateKind === kind && key.startsWith(prefix) && seen <= cutoff) confirmed.add(key);
    }
    return confirmed;
  }

  /** Keep the first sighting of each awaited change; forget changes this pass didn't await. */
  private updateCandidates(prefix: string, actions: SyncAction[]): void {
    const awaited = new Set<string>();
    for (const action of actions) {
      if (action.type === "awaitRemoval") awaited.add(`remove\n${action.ticketKey}`);
      if (action.type === "awaitAdd") awaited.add(`add\n${action.ticketKey}`);
    }
    for (const candidate of [...this.candidates.keys()]) {
      if (splitCandidate(candidate)[1].startsWith(prefix) && !awaited.has(candidate)) {
        this.candidates.delete(candidate);
      }
    }
    for (const candidate of awaited) {
      if (!this.candidates.has(candidate)) this.candidates.set(candidate, this.now());
    }
    if (awaited.size > 0) {
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
      case "removeItems": {
        // An item completed on another device since this pass read Focus stays, for "done today"
        const current = await api.getFocusItems(SOURCE_NAME);
        const stillUnfinished = action.itemIds.filter((id) =>
          current.some((item) => item.id === id && item.completedAt === undefined)
        );
        await this.applyToItems(api, stillUnfinished, (id) => api.removeFocusItem(id));
        await this.setRecord(action.ticketKey, null);
        break;
      }
      case "addLabel": {
        const labelId = await this.labelIdOrCreate(workspace, client);
        await this.changeLabel(workspace, () => client.addLabel(action.issueId, labelId));
        await this.setRecord(action.ticketKey, { issueId: action.issueId, label: "synced" });
        break;
      }
      case "removeLabel": {
        // Recorded first, so a failed removal is retried without waiting for confirmation again
        await this.setRecord(action.ticketKey, {
          issueId: action.issueId,
          label: "remove-pending",
        });
        const labelId = await this.labelIdOrCreate(workspace, client);
        await this.changeLabel(workspace, () => client.removeLabel(action.issueId, labelId));
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

  private labelCacheKey(workspace: WorkspaceSettings): string {
    return `${workspace.urlKey}\n${this.deps.getData().settings.labelName.toLowerCase()}`;
  }

  /** The workspace-level label's id, or null if the workspace doesn't have it yet. */
  private async findLabelId(
    workspace: WorkspaceSettings,
    client: LinearWorkspaceClient
  ): Promise<string | null> {
    const cacheKey = this.labelCacheKey(workspace);
    const cached = this.labelIds.get(cacheKey);
    if (cached) return cached;
    const id = await client.findWorkspaceLabel(this.deps.getData().settings.labelName);
    if (id) this.labelIds.set(cacheKey, id);
    return id;
  }

  private async labelIdOrCreate(
    workspace: WorkspaceSettings,
    client: LinearWorkspaceClient
  ): Promise<string> {
    const found = await this.findLabelId(workspace, client);
    if (found) return found;
    const id = await client.createWorkspaceLabel(this.deps.getData().settings.labelName);
    this.labelIds.set(this.labelCacheKey(workspace), id);
    return id;
  }

  /** Run a label change; if Linear rejects it, look the label up afresh next time. */
  private async changeLabel(workspace: WorkspaceSettings, change: () => Promise<void>) {
    try {
      await change();
    } catch (error) {
      if (error instanceof LinearError && error.kind === "api") {
        this.labelIds.delete(this.labelCacheKey(workspace));
      }
      throw error;
    }
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
      this.notifyOnce(urlKey, "other", `Flow Linear couldn't sync ${displayName}: ${message}`);
      return;
    }
    switch (error.kind) {
      case "auth":
        this.refusedKeys.set(urlKey, apiKey);
        this.notifyOnce(
          urlKey,
          "auth",
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
        this.notifyOnce(urlKey, "unreachable", `Couldn't reach Linear for ${displayName}`);
        break;
    }
  }

  // One notice per workspace and kind of problem per session
  private notifyOnce(urlKey: string, kind: string, message: string): void {
    const key = `${urlKey}\n${kind}`;
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.deps.notify(message);
  }
}
