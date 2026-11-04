// ABOUTME: Tests checking a new workspace's API key with Linear before saving it.
// ABOUTME: Covers a missing key, a refused key, a duplicate workspace and the display name default.

import { checkWorkspace, WorkspaceFormInput } from "../src/workspace-form";
import { workspace } from "./helpers/builders";
import { LinearWorkspace } from "./helpers/linear-workspace";

const input: WorkspaceFormInput = {
  apiKeySecretName: "linear-testco",
  displayName: "",
  defaultSphere: "work",
};

function check(overrides: Partial<WorkspaceFormInput> = {}, linear = new LinearWorkspace()) {
  return checkWorkspace(
    { ...input, ...overrides },
    [workspace("existing")],
    (name) => (name === "linear-testco" ? "key" : null),
    () => linear
  );
}

describe("checkWorkspace", () => {
  it("fills in the urlKey and the organisation's name", async () => {
    expect(await check()).toEqual({
      ok: true,
      workspace: {
        urlKey: "testco",
        displayName: "Testco",
        apiKeySecretName: "linear-testco",
        defaultSphere: "work",
      },
    });
  });

  it("keeps a display name that was typed", async () => {
    const result = await check({ displayName: "  Test company " });
    expect(result.ok && result.workspace.displayName).toBe("Test company");
  });

  it("asks for a key when none is chosen", async () => {
    expect(await check({ apiKeySecretName: "" })).toEqual({
      ok: false,
      error: "Choose an API key.",
    });
  });

  it("refuses a secret with no value on this device", async () => {
    expect(await check({ apiKeySecretName: "linear-other" })).toEqual({
      ok: false,
      error: "That secret has no value on this device.",
    });
  });

  it("reports a key that Linear refuses", async () => {
    const linear = new LinearWorkspace();
    linear.failNext("getOrganization", "auth");
    expect(await check({}, linear)).toEqual({
      ok: false,
      error: "Couldn't check the key with Linear: getOrganization failed (auth)",
    });
  });

  it("refuses a workspace that's already set up", async () => {
    expect(await check({}, new LinearWorkspace("existing", "Existing"))).toEqual({
      ok: false,
      error: "Existing (existing) is already set up.",
    });
  });
});
