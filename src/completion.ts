// ABOUTME: Completes Focus items whose Linear tickets are done, cancelled or trashed.
// ABOUTME: Checks one run at a time, queues a single follow-up, and keeps per-workspace status.

import { ExternalFocusItem, ExternalFocusItemChanges, FlowApi, SOURCE_NAME } from "./flow-api";
import { LinearError, LinearTicket, LinearWorkspaceClient } from "./linear-client";
import { FlowLinearSettings, WorkspaceSettings } from "./settings";
import { parseTicketUrl } from "./ticket-url";

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

export interface ItemToComplete {
  itemId: string;
  identifier: string;
  reason: "closed" | "deleted"; // Deleted means trashed in Linear
}

export interface ItemUpdate {
  itemId: string;
  // A new link and identifier when the ticket moved or its team was renamed, and the ticket's
  // project name when it differs from the item's (null clears it)
  changes: ExternalFocusItemChanges;
}

export interface CompletionPlan {
  complete: ItemToComplete[];
  update: ItemUpdate[]; // Items of open tickets whose link or project is out of date
  // Identifiers Linear didn't return. The key may not see them, so their items are left alone.
  notVisible: string[];
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
 * Decide what a check does, given each ticket from Linear (null when Linear returned nothing).
 * Only a ticket Linear shows as completed, cancelled or trashed completes its items: "not
 * found" may only mean this key can't see the ticket.
 */
export function planCompletionCheck(
  itemsByIdentifier: Map<string, ExternalFocusItem[]>,
  tickets: Map<string, LinearTicket | null>,
  options: { projectNames: boolean } = { projectNames: true }
): CompletionPlan {
  const plan: CompletionPlan = { complete: [], update: [], notVisible: [] };
  for (const [identifier, items] of itemsByIdentifier) {
    if (!tickets.has(identifier)) continue;
    const ticket = tickets.get(identifier) ?? null;
    if (!ticket) {
      plan.notVisible.push(identifier);
      continue;
    }
    const reason = ticket.trashed
      ? "deleted"
      : CLOSED_STATE_TYPES.has(ticket.stateType)
        ? "closed"
        : null;
    if (reason) {
      for (const item of items) plan.complete.push({ itemId: item.id, identifier, reason });
      continue;
    }
    for (const item of items) {
      const changes: ExternalFocusItemChanges = {};
      if (ticket.identifier !== identifier) {
        changes.url = ticket.url;
        changes.externalId = ticket.identifier;
      }
      if (options.projectNames && (item.external.projectName ?? null) !== ticket.projectName) {
        changes.projectName = ticket.projectName;
      }
      if (Object.keys(changes).length > 0) plan.update.push({ itemId: item.id, changes });
    }
  }
  return plan;
}

export interface WorkspaceStatus {
  lastSuccessAt?: number;
  error?: string;
  notVisible?: string[]; // Identifiers the key couldn't see on the last check
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

/** A key that belongs to a different Linear workspace from the one it's set up for. */
export function wrongWorkspaceMessage(workspace: WorkspaceSettings, actualUrlKey: string): string {
  return `The API key for ${workspace.displayName} belongs to the Linear workspace "${actualUrlKey}", not "${workspace.urlKey}". Check the key in Flow Linear's settings.`;
}

export function notVisibleMessage(identifiers: string[]): string {
  const count = identifiers.length;
  return `${count} ${count === 1 ? "ticket" : "tickets"} not visible with this key: ${identifiers.join(", ")}`;
}

class WrongWorkspaceError extends Error {}

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
  // Whether this Flow keeps project names; unknown until the first project name update
  private projectNamesKept: boolean | undefined = undefined;
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
      if (!this.stillConnected(api)) return;
      await this.checkWorkspace(api, workspace);
    }
  }

  private stillConnected(api: FlowApi): boolean {
    return !this.stopped && this.deps.getFlowApi() === api;
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
      let notVisible: string[] = [];
      if (items.size > 0) {
        const client = this.deps.createClient(apiKey);
        // data.json names only the secret, so another device's secret of that name may hold a
        // key for a different workspace
        const organization = await client.getOrganization();
        if (organization.urlKey !== urlKey) {
          throw new WrongWorkspaceError(wrongWorkspaceMessage(workspace, organization.urlKey));
        }
        const plan = planCompletionCheck(items, await client.getTickets([...items.keys()]), {
          projectNames: this.projectNamesKept !== false,
        });
        notVisible = plan.notVisible;
        if (notVisible.length > 0) {
          this.notifyOnce(
            urlKey,
            "not-visible",
            `Flow Linear, ${workspace.displayName}: ${notVisibleMessage(notVisible)}`
          );
        }
        await this.carryOut(api, workspace, plan);
      }
      this.refusedKeys.delete(urlKey);
      this.statuses.set(urlKey, {
        lastSuccessAt: this.now(),
        ...(notVisible.length > 0 ? { notVisible } : {}),
      });
    } catch (error) {
      // Flow unloaded mid-check and its API now refuses writes; it will be found again
      if (!this.stillConnected(api)) return;
      this.handleError(workspace, apiKey, error);
    }
  }

  /**
   * Relink moved tickets' items, then complete finished ones. A change to an item that has
   * gone, or that is already complete, counts as done.
   */
  private async carryOut(
    api: FlowApi,
    workspace: WorkspaceSettings,
    plan: CompletionPlan
  ): Promise<void> {
    const failures: Error[] = [];
    const attempt = async (itemId: string, change: () => Promise<void>): Promise<boolean> => {
      try {
        await change();
        return true;
      } catch (error) {
        const current = await api.getFocusItems(SOURCE_NAME);
        const item = current.find((entry) => entry.id === itemId);
        if (item && item.completedAt === undefined) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
        return false;
      }
    };

    for (const { itemId, changes } of plan.update) {
      if (!this.stillConnected(api)) return;
      // Flow builds from before externalId or projectName could be changed ignore those
      // fields. The link still updates, which is what later checks read.
      const updated = await attempt(itemId, () => api.updateFocusItem(itemId, changes));
      if (updated && changes.projectName !== undefined) {
        await this.checkProjectNameKept(api, itemId, changes.projectName);
      }
    }
    for (const { itemId, identifier, reason } of plan.complete) {
      if (!this.stillConnected(api)) return;
      const completed = await attempt(itemId, () => api.completeFocusItem(itemId));
      if (completed && reason === "deleted") {
        console.warn(
          `Flow Linear: ${identifier} was deleted in ${workspace.displayName}, so its Focus item was completed`
        );
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * A Flow build that drops projectName would make every check try to set it again, so after
   * the first such update read the item back and stop sending project names if it didn't stick.
   */
  private async checkProjectNameKept(
    api: FlowApi,
    itemId: string,
    projectName: string | null
  ): Promise<void> {
    if (this.projectNamesKept !== undefined) return;
    const item = (await api.getFocusItems(SOURCE_NAME)).find((entry) => entry.id === itemId);
    if (item) this.projectNamesKept = (item.external.projectName ?? null) === projectName;
  }

  private handleError(workspace: WorkspaceSettings, apiKey: string, error: unknown): void {
    const { urlKey, displayName } = workspace;
    const message = errorMessage(error);
    this.statuses.set(urlKey, { ...this.getStatus(urlKey), error: message });

    if (error instanceof WrongWorkspaceError) {
      this.notifyOnce(urlKey, "wrong-workspace", message);
      return;
    }
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
