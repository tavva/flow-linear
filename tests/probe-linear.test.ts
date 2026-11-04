// ABOUTME: Checks scripts/probe-linear.mjs sends exactly the queries the plugin sends.
// ABOUTME: The probe can't import the TypeScript client, so it keeps its own copies of them.

import { readFileSync } from "fs";
import { join } from "path";
import { QUERIES } from "../src/linear-client";

const probe = readFileSync(join(__dirname, "..", "scripts", "probe-linear.mjs"), "utf-8");

describe("probe-linear", () => {
  it.each(Object.entries(QUERIES))("sends the plugin's %s query unchanged", (_, query) => {
    expect(probe).toContain(JSON.stringify(query));
  });

  it("refuses to send mutations", () => {
    expect(probe).toContain("The probe never sends mutations");
    for (const query of Object.values(QUERIES)) expect(query).not.toMatch(/\bmutation\b/);
  });

  it("never prints the key", () => {
    expect(probe).not.toMatch(/console\.\w+\([^)]*apiKey/);
  });
});
