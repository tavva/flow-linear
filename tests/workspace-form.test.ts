// ABOUTME: Tests checking a Linear API key for a new workspace or as a replacement key.
// ABOUTME: Covers an empty key, a refused key, a duplicate workspace and a key for another workspace.

import { checkReplacementKey, checkWorkspace, WorkspaceFormInput } from "../src/workspace-form";
import { workspace } from "./helpers/builders";
import { LinearWorkspace } from "./helpers/linear-workspace";

const input: WorkspaceFormInput = {
  apiKey: "  lin_api_test  ",
  displayName: "",
  defaultSphere: "work",
};

function check(overrides: Partial<WorkspaceFormInput> = {}, linear = new LinearWorkspace()) {
  return checkWorkspace({ ...input, ...overrides }, [workspace("existing")], () => linear);
}

describe("checkWorkspace", () => {
  it("fills in the urlKey, the organisation's name and the plugin's secret name", async () => {
    expect(await check()).toEqual({
      ok: true,
      apiKey: "lin_api_test",
      workspace: {
        urlKey: "testco",
        displayName: "Testco",
        apiKeySecretName: "flow-linear-testco",
        defaultSphere: "work",
      },
    });
  });

  it("keeps a display name that was typed", async () => {
    const result = await check({ displayName: "  Test company " });
    expect(result.ok && result.workspace.displayName).toBe("Test company");
  });

  it("asks for a key when none is pasted", async () => {
    expect(await check({ apiKey: "   " })).toEqual({
      ok: false,
      error: "Paste your Linear API key.",
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

  it("refuses a workspace that's already set up, pointing to Change key", async () => {
    expect(await check({}, new LinearWorkspace("existing", "Existing"))).toEqual({
      ok: false,
      error:
        'Existing (existing) is already set up. Use its "Change key" button to replace the key.',
    });
  });
});

describe("checkReplacementKey", () => {
  it("accepts a key for the same workspace", async () => {
    expect(
      await checkReplacementKey(" lin_api_new ", workspace(), () => new LinearWorkspace())
    ).toEqual({ ok: true, apiKey: "lin_api_new" });
  });

  it("refuses a key for another workspace", async () => {
    const result = await checkReplacementKey(
      "lin_api_other",
      workspace(),
      () => new LinearWorkspace("otherco", "Otherco")
    );
    expect(result).toEqual({
      ok: false,
      error:
        'The API key for Testco belongs to the Linear workspace "otherco", not "testco". Check the key in Flow Linear\'s settings.',
    });
  });

  it("refuses an empty key and a key Linear refuses", async () => {
    expect(await checkReplacementKey("", workspace(), () => new LinearWorkspace())).toEqual({
      ok: false,
      error: "Paste your Linear API key.",
    });
    const linear = new LinearWorkspace();
    linear.failNext("getOrganization", "auth");
    expect((await checkReplacementKey("lin_api_bad", workspace(), () => linear)).ok).toBe(false);
  });
});
