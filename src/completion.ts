// ABOUTME: Completes Focus items whose Linear tickets are done, cancelled or deleted.
// ABOUTME: Checks one run at a time, queues a single follow-up, and keeps per-workspace status.

import { ExternalFocusItem, FlowApi, SOURCE_NAME } from "./flow-api";
import { LinearError, LinearTicket, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearSettings, WorkspaceSettings } from "./settings";
import { parseTicketUrl } from "./ticket-url";

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

export interface ItemToComplete {
  itemId: string;
  identifier: string;
  reason: "closed" | "deleted";
}

/** The workspace's unfinished linked items, by the identifier in each item's link. */
export function unfinishedItemsByIdentifier(
  items: ExternalFocusItem[],
  workspace: WorkspaceSettings
): Map<string, ExternalFocusItem[]> {
  const byIdentifier = new Map<string, ExternalFocusItem[]>();
  for (const item of items) {
    if (item.completedAt !== undefined) continue;
    const ref = parseTicketUrl(item.external.url);
    if (!ref || ref.urlKey !== workspace.urlKey) continue;
    byIdentifier.set(ref.identifier, [...(byIdentifier.get(ref.identifier) ?? []), item]);
  }
  return byIdentifier;
}

/**
 * Which items to complete, given each ticket's state from Linear (null when Linear says there's
 * no such ticket). Deleted and trashed tickets count as done.
 */
export function findItemsToComplete(
  itemsByIdentifier: Map<string, ExternalFocusItem[]>,
  tickets: Map<string, LinearTicket | null>
): ItemToComplete[] {
  const toComplete: ItemToComplete[] = [];
  for (const [identifier, items] of itemsByIdentifier) {
    if (!tickets.has(identifier)) continue;
    const ticket = tickets.get(identifier) ?? null;
    let reason: ItemToComplete["reason"] | null = null;
    if (!ticket || ticket.trashed) reason = "deleted";
    else if (CLOSED_STATE_TYPES.has(ticket.stateType)) reason = "closed";
    if (!reason) continue;
    for (const item of items) toComplete.push({ itemId: item.id, identifier, reason });
  }
  return toComplete;
}

export interface WorkspaceStatus {
  lastSuccessAt?: number;
  error?: string;
}

export interface CompletionCheckerDeps {
  getFlowApi(): FlowApi | null;
  getSettings(): FlowLinearSettings;
  getSecret(name: string): string | null;
  createClient(apiKey: string): LinearWorkspaceClient;
  notify(message: string): void;
  now?: () => number;
}

export const NO_KEY_STATUS = "No API key on this device";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CompletionChecker {
  private running: Promise<void> | null = null;
  private queued = false;
  private statuses = new Map<string, WorkspaceStatus>();
  private notified = new Set<string>();
  private refusedKeys = new Map<string, string>(); // urlKey → the API key Linear refused
  private rateLimitedUntil = new Map<string, number>();
  private stopped = false;
  private now: () => number;

  constructor(private deps: CompletionCheckerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Start a check, or queue one follow-up if a check is running. */
  requestCheck(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.runUntilSettled().finally(() => {
      this.running = null;
      // A request that arrived after the last check of `queued` would otherwise be lost
      if (this.queued && !this.stopped) {
        this.requestCheck().catch((error) => console.error("Flow Linear check failed", error));
      }
    });
    return this.running;
  }

  /** Stop at the next step and start no more checks. Called when the plugin unloads. */
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
    for (const workspace of [...this.deps.getSettings().workspaces]) {
      if (this.stopped || this.deps.getFlowApi() !== api) return;
      await this.checkWorkspace(api, workspace);
    }
  }

  private async checkWorkspace(api: FlowApi, workspace: WorkspaceSettings): Promise<void> {
    const { urlKey } = workspace;
    const apiKey = this.deps.getSecret(workspace.apiKeySecretName);
    if (!apiKey) {
      this.statuses.set(urlKey, { ...this.getStatus(urlKey), error: NO_KEY_STATUS });
      return;
    }
    if (this.refusedKeys.get(urlKey) === apiKey) return;
    if ((this.rateLimitedUntil.get(urlKey) ?? 0) > this.now()) return;

    try {
      const items = unfinishedItemsByIdentifier(await api.getFocusItems(SOURCE_NAME), workspace);
      if (items.size > 0) {
        const tickets = await this.deps.createClient(apiKey).getTickets([...items.keys()]);
        await this.complete(api, workspace, findItemsToComplete(items, tickets));
      }
      this.refusedKeys.delete(urlKey);
      this.statuses.set(urlKey, { lastSuccessAt: this.now() });
    } catch (error) {
      // Flow unloaded mid-check and its API now refuses writes; it will be found again
      if (this.deps.getFlowApi() !== api || this.stopped) return;
      this.handleError(workspace, apiKey, error);
    }
  }

  /** Complete each item. One that has gone or is already complete counts as done. */
  private async complete(
    api: FlowApi,
    workspace: WorkspaceSettings,
    toComplete: ItemToComplete[]
  ): Promise<void> {
    let firstError: Error | null = null;
    for (const { itemId, identifier, reason } of toComplete) {
      if (this.stopped) return;
      if (reason === "deleted") {
        console.warn(
          `Flow Linear: ${identifier} is no longer in ${workspace.displayName}, so its Focus item was completed`
        );
      }
      try {
        await api.completeFocusItem(itemId);
      } catch (error) {
        const current = await api.getFocusItems(SOURCE_NAME);
        const item = current.find((entry) => entry.id === itemId);
        if (item && item.completedAt === undefined) {
          firstError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    if (firstError) throw firstError;
  }

  private handleError(workspace: WorkspaceSettings, apiKey: string, error: unknown): void {
    const { urlKey, displayName } = workspace;
    const message = errorMessage(error);
    this.statuses.set(urlKey, { ...this.getStatus(urlKey), error: message });

    if (!(error instanceof LinearError)) {
      console.error(`Flow Linear check failed for ${displayName}`, error);
      this.notifyOnce(urlKey, "other", `Flow Linear couldn't check ${displayName}: ${message}`);
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
        const minutes = this.deps.getSettings().checkIntervalMinutes;
        this.rateLimitedUntil.set(urlKey, this.now() + minutes * 60_000);
        break;
      }
      case "network":
        this.notifyOnce(urlKey, "network", `Couldn't reach Linear for ${displayName}`);
        break;
      case "api":
        this.notifyOnce(urlKey, "api", `Linear reported an error for ${displayName}: ${message}`);
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
