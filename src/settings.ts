// ABOUTME: Settings and stored data for Flow Linear, with defaults.
// ABOUTME: Turns whatever loadData() returns into a complete, well-formed data object.

export interface WorkspaceSettings {
  urlKey: string; // From the API, e.g. "acme"
  displayName: string; // e.g. "Acme"
  apiKeySecretName: string; // Name in Obsidian's SecretStorage
  defaultSphere: string;
}

export interface FlowLinearSettings {
  workspaces: WorkspaceSettings[];
  labelName: string;
  checkIntervalMinutes: number;
  oldFlowWarningDismissed: boolean; // The settings tab's warning about Flow 1.3.12 and earlier
}

export type LabelState = "synced" | "add-pending" | "remove-pending";

export interface TicketRecord {
  issueId: string; // Linear UUID, needed by the label mutations
  label: LabelState;
  // Set when the label name was changed in settings: the old label this record is about, which
  // comes off before the new one goes on. Absent means the current label name.
  labelName?: string;
}

export interface FlowLinearData {
  settings: FlowLinearSettings;
  tickets: Record<string, TicketRecord>; // Keyed by ticket key, e.g. "acme/ABC-123"
}

export const DEFAULT_LABEL_NAME = "flow-focus";
export const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
export const MIN_CHECK_INTERVAL_MINUTES = 1;

export function defaultSettings(): FlowLinearSettings {
  return {
    workspaces: [],
    labelName: DEFAULT_LABEL_NAME,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    oldFlowWarningDismissed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function readWorkspace(value: unknown): WorkspaceSettings | null {
  if (!isRecord(value)) return null;
  const { urlKey, displayName, apiKeySecretName, defaultSphere } = value;
  if (!isString(urlKey) || urlKey === "" || !isString(apiKeySecretName)) return null;
  return {
    urlKey,
    displayName: isString(displayName) && displayName.trim() !== "" ? displayName : urlKey,
    apiKeySecretName,
    defaultSphere: isString(defaultSphere) ? defaultSphere : "",
  };
}

function readTicketRecord(value: unknown): TicketRecord | null {
  if (!isRecord(value)) return null;
  const { issueId, label, labelName } = value;
  if (!isString(issueId) || issueId === "") return null;
  if (label !== "synced" && label !== "add-pending" && label !== "remove-pending") return null;
  return isString(labelName) && labelName !== ""
    ? { issueId, label, labelName }
    : { issueId, label };
}

/** Read stored data, dropping anything malformed and filling in defaults. */
export function readStoredData(raw: unknown): FlowLinearData {
  const settings = defaultSettings();
  const tickets: Record<string, TicketRecord> = {};
  if (!isRecord(raw)) return { settings, tickets };

  const storedSettings = isRecord(raw.settings) ? raw.settings : {};
  if (Array.isArray(storedSettings.workspaces)) {
    for (const entry of storedSettings.workspaces) {
      const workspace = readWorkspace(entry);
      if (workspace && !settings.workspaces.some((w) => w.urlKey === workspace.urlKey)) {
        settings.workspaces.push(workspace);
      }
    }
  }
  if (isString(storedSettings.labelName) && storedSettings.labelName.trim() !== "") {
    settings.labelName = storedSettings.labelName.trim();
  }
  if (typeof storedSettings.checkIntervalMinutes === "number") {
    settings.checkIntervalMinutes = clampInterval(storedSettings.checkIntervalMinutes);
  }
  if (storedSettings.oldFlowWarningDismissed === true) {
    settings.oldFlowWarningDismissed = true;
  }

  if (isRecord(raw.tickets)) {
    for (const [key, value] of Object.entries(raw.tickets)) {
      const record = readTicketRecord(value);
      if (record) tickets[key] = record;
    }
  }

  return { settings, tickets };
}

export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CHECK_INTERVAL_MINUTES;
  return Math.max(MIN_CHECK_INTERVAL_MINUTES, Math.round(minutes));
}
