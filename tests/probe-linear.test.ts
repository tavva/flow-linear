// ABOUTME: Checks scripts/probe-linear.mjs sends exactly the queries the plugin sends.
// ABOUTME: The probe can't import the TypeScript client, so it builds its own copies of them.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { QUERIES } from "../src/linear-client";

const probePath = join(__dirname, "..", "scripts", "probe-linear.mjs");
const probe = readFileSync(probePath, "utf-8");

function probeQueries(count: number): { organization: string; tickets: string } {
  // Prints the queries without sending anything or needing a key
  return JSON.parse(
    execFileSync(process.execPath, [probePath, "--print-queries", String(count)], {
      encoding: "utf-8",
      env: {},
    })
  );
}

describe("probe-linear", () => {
  it.each([1, 3, 50])("builds the plugin's queries for %i tickets", (count) => {
    expect(probeQueries(count)).toEqual({
      organization: QUERIES.organization,
      tickets: QUERIES.tickets(count),
    });
  });

  it("refuses to send mutations", () => {
    expect(probe).toContain("The probe never sends mutations");
    expect(QUERIES.organization).not.toMatch(/\bmutation\b/);
    expect(QUERIES.tickets(3)).not.toMatch(/\bmutation\b/);
  });

  it("never prints the key", () => {
    expect(probe).not.toMatch(/console\.\w+\([^)]*apiKey/);
  });
});
