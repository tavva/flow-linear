// ABOUTME: The narrow slice of Flow's public Focus API that Flow Linear uses, copied from Flow.
// ABOUTME: Also finds the API on Obsidian's plugin registry, which isn't in the public typings.

import { App } from "obsidian";

export interface ExternalSource {
  sourceName: string; // Owning plugin's source, e.g. "linear"
  sourceLabel: string; // Shown as a chip, e.g. "Acme"
  url: string; // Opened when the item is clicked
  externalId: string; // The source's own ID, e.g. "ABC-123"
  projectName?: string; // The source's project, e.g. "Website relaunch"; shown under the item's wording
}

export interface ExternalFocusItem {
  id: string; // Stable ID, assigned by Flow
  text: string;
  sphere: string;
  addedAt: number;
  isPinned?: boolean;
  completedAt?: number;
  contexts?: string[];
  external: ExternalSource;
}

export interface NewExternalFocusItem {
  text: string;
  sphere: string;
  sourceName: string;
  sourceLabel: string;
  url: string;
  externalId: string;
  // Leave out, or pass null or "", for no project. Since Flow's 6287777; earlier builds drop it
  projectName?: string | null;
}

export type ExternalFocusItemChanges = Partial<{
  text: string;
  sphere: string;
  sourceLabel: string;
  url: string;
  externalId: string; // Accepted since Flow's 2d771e9; earlier builds ignore it
  projectName: string | null; // null or "" clears it. Since Flow's 6287777; earlier builds ignore it
}>;

export type FocusChange =
  | { type: "added"; item: ExternalFocusItem }
  | { type: "edited"; item: ExternalFocusItem; previous: ExternalFocusItem }
  | { type: "completed"; item: ExternalFocusItem }
  | { type: "removed"; item: ExternalFocusItem };

export type FocusChangeCallback = (change: FocusChange) => void;

export interface FlowApi {
  apiVersion: number; // Flow Linear supports version 1

  addFocusItem(input: NewExternalFocusItem): Promise<string>; // Returns the new item's id
  updateFocusItem(id: string, changes: ExternalFocusItemChanges): Promise<void>;
  completeFocusItem(id: string): Promise<void>; // Sets completedAt
  removeFocusItem(id: string): Promise<void>;

  getFocusItems(sourceName: string): Promise<ExternalFocusItem[]>;
  getSpheres(): string[];

  onFocusChange(sourceName: string, callback: FocusChangeCallback): () => void;
}

export const SUPPORTED_API_VERSION = 1;
export const SOURCE_NAME = "linear";
export const FLOW_API_READY_EVENT = "flow:api-ready";
export const FLOW_API_UNLOADED_EVENT = "flow:api-unloaded";

interface PluginRegistry {
  getPlugin(id: string): { api?: unknown } | null;
}

export type FlowLookup =
  | { status: "missing" } // Flow isn't enabled
  | { status: "no-api" } // Flow is enabled but predates the Focus API
  | { status: "found"; api: FlowApi }; // Any API version; the caller checks it

function hasApiVersion(api: unknown): api is FlowApi {
  return (
    typeof api === "object" &&
    api !== null &&
    typeof (api as { apiVersion?: unknown }).apiVersion === "number"
  );
}

export function findFlow(app: App): FlowLookup {
  const plugins = (app as App & { plugins?: PluginRegistry }).plugins;
  const flow = plugins?.getPlugin("flow");
  if (!flow) return { status: "missing" };
  return hasApiVersion(flow.api) ? { status: "found", api: flow.api } : { status: "no-api" };
}

/** Flow's API if Flow is enabled and has one, whatever its version, or null. */
export function findFlowApi(app: App): FlowApi | null {
  const lookup = findFlow(app);
  return lookup.status === "found" ? lookup.api : null;
}
