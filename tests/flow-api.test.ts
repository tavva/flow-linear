// ABOUTME: Tests finding Flow's API on Obsidian's plugin registry.
// ABOUTME: Tells apart Flow missing, Flow too old to have the API, and Flow with an API.

import { findFlow, findFlowApi } from "../src/flow-api";
import { FocusStore } from "./helpers/focus-store";

function appWith(flow: unknown) {
  return { plugins: { getPlugin: (id: string) => (id === "flow" ? flow : null) } } as never;
}

describe("findFlow", () => {
  it("reports Flow missing when it isn't enabled", () => {
    expect(findFlow(appWith(null))).toEqual({ status: "missing" });
    expect(findFlow({} as never)).toEqual({ status: "missing" });
  });

  it.each([
    ["no api", {}],
    ["an api without apiVersion", { api: { addFocusItem() {} } }],
    ["a non-object api", { api: "yes" }],
  ])("reports a Flow with %s as too old", (_, flow) => {
    expect(findFlow(appWith(flow))).toEqual({ status: "no-api" });
    expect(findFlowApi(appWith(flow))).toBeNull();
  });

  it("returns the API whatever its version", () => {
    const api = new FocusStore();
    expect(findFlow(appWith({ api }))).toEqual({ status: "found", api });
    const future = { apiVersion: 2 };
    expect(findFlowApi(appWith({ api: future }))).toBe(future);
  });
});
