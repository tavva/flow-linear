// ABOUTME: Tests reading stored data into complete settings.
// ABOUTME: Malformed or missing data must fall back to defaults rather than break loading.

import { clampInterval, defaultSettings, readSettings } from "../src/settings";

describe("readSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readSettings(null)).toEqual(defaultSettings());
    expect(defaultSettings()).toEqual({
      workspaces: [],
      checkIntervalMinutes: 5,
      oldFlowWarningDismissed: false,
    });
  });

  it("keeps well-formed settings", () => {
    const stored = {
      workspaces: [
        {
          urlKey: "acme",
          displayName: "Acme",
          apiKeySecretName: "linear-acme",
          defaultSphere: "work",
        },
      ],
      checkIntervalMinutes: 10,
      oldFlowWarningDismissed: true,
    };
    expect(readSettings(stored)).toEqual(stored);
  });

  it("drops malformed workspaces and duplicates, and unknown fields", () => {
    const settings = readSettings({
      workspaces: [
        { urlKey: "", apiKeySecretName: "x" },
        "nonsense",
        { urlKey: "a", apiKeySecretName: "key-a" },
        { urlKey: "a", apiKeySecretName: "key-b" },
      ],
      checkIntervalMinutes: 0,
      oldFlowWarningDismissed: "yes",
      labelName: "flow-focus",
    });
    expect(settings).toEqual({
      workspaces: [{ urlKey: "a", displayName: "a", apiKeySecretName: "key-a", defaultSphere: "" }],
      checkIntervalMinutes: 1,
      oldFlowWarningDismissed: false,
    });
  });

  it("ignores data of the wrong type", () => {
    expect(readSettings([])).toEqual(defaultSettings());
    expect(readSettings({ workspaces: "none" })).toEqual(defaultSettings());
  });
});

describe("clampInterval", () => {
  it("rounds and keeps the interval at least a minute", () => {
    expect(clampInterval(2.4)).toBe(2);
    expect(clampInterval(-5)).toBe(1);
    expect(clampInterval(Number.NaN)).toBe(5);
  });
});
