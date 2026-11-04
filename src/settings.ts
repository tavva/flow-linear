// ABOUTME: Settings for Flow Linear, with defaults.
// ABOUTME: Turns whatever loadData() returns into complete, well-formed settings.

export interface WorkspaceSettings {
  urlKey: string; // From the API, e.g. "acme"
  displayName: string; // e.g. "Acme"
  apiKeySecretName: string; // Name in Obsidian's SecretStorage
  defaultSphere: string;
}

export interface FlowLinearSettings {
  workspaces: WorkspaceSettings[];
  checkIntervalMinutes: number;
  oldFlowWarningDismissed: boolean; // The settings tab's warning about Flow 1.3.12 and earlier
}

export const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
export const MIN_CHECK_INTERVAL_MINUTES = 1;

export function defaultSettings(): FlowLinearSettings {
  return {
    workspaces: [],
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

/** Read stored settings, dropping anything malformed and filling in defaults. */
export function readSettings(raw: unknown): FlowLinearSettings {
  const settings = defaultSettings();
  if (!isRecord(raw)) return settings;

  if (Array.isArray(raw.workspaces)) {
    for (const entry of raw.workspaces) {
      const workspace = readWorkspace(entry);
      if (workspace && !settings.workspaces.some((w) => w.urlKey === workspace.urlKey)) {
        settings.workspaces.push(workspace);
      }
    }
  }
  if (typeof raw.checkIntervalMinutes === "number") {
    settings.checkIntervalMinutes = clampInterval(raw.checkIntervalMinutes);
  }
  if (raw.oldFlowWarningDismissed === true) {
    settings.oldFlowWarningDismissed = true;
  }
  return settings;
}

export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CHECK_INTERVAL_MINUTES;
  return Math.max(MIN_CHECK_INTERVAL_MINUTES, Math.round(minutes));
}
