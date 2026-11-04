// ABOUTME: Tests reading stored data into complete settings and ticket records.
// ABOUTME: Malformed or missing data must fall back to defaults rather than break loading.

import { clampInterval, defaultSettings, readStoredData } from "../src/settings";

describe("readStoredData", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readStoredData(null)).toEqual({ settings: defaultSettings(), tickets: {} });
    expect(defaultSettings()).toEqual({
      workspaces: [],
      labelName: "flow-focus",
      checkIntervalMinutes: 5,
    });
  });

  it("keeps well-formed settings and records", () => {
    const stored = {
      settings: {
        workspaces: [
          {
            urlKey: "acme",
            displayName: "Acme",
            apiKeySecretName: "linear-acme",
            defaultSphere: "work",
          },
        ],
        labelName: "ben-focus",
        checkIntervalMinutes: 10,
      },
      tickets: { "acme/ABC-1": { issueId: "uuid-1", label: "add-pending" } },
    };
    expect(readStoredData(stored)).toEqual(stored);
  });

  it("drops malformed workspaces, duplicates and records", () => {
    const data = readStoredData({
      settings: {
        workspaces: [
          { urlKey: "", apiKeySecretName: "x" },
          "nonsense",
          { urlKey: "a", apiKeySecretName: "key-a" },
          { urlKey: "a", apiKeySecretName: "key-b" },
        ],
        labelName: "  ",
        checkIntervalMinutes: 0,
      },
      tickets: {
        "a/A-1": { issueId: "", label: "synced" },
        "a/A-2": { issueId: "uuid", label: "maybe" },
        "a/A-3": null,
        "a/A-4": { issueId: "uuid-4", label: "remove-pending" },
      },
    });
    expect(data.settings.workspaces).toEqual([
      { urlKey: "a", displayName: "a", apiKeySecretName: "key-a", defaultSphere: "" },
    ]);
    expect(data.settings.labelName).toBe("flow-focus");
    expect(data.settings.checkIntervalMinutes).toBe(1);
    expect(data.tickets).toEqual({ "a/A-4": { issueId: "uuid-4", label: "remove-pending" } });
  });

  it("ignores settings and tickets of the wrong type", () => {
    expect(readStoredData({ settings: [], tickets: [] })).toEqual(readStoredData(undefined));
  });
});

describe("clampInterval", () => {
  it("rounds and keeps the interval at least a minute", () => {
    expect(clampInterval(2.4)).toBe(2);
    expect(clampInterval(-5)).toBe(1);
    expect(clampInterval(Number.NaN)).toBe(5);
  });
});
