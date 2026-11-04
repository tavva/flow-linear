// ABOUTME: Two devices sharing a Linear workspace, each with its own focus file and data.json copy.
// ABOUTME: Tests that a device whose synced files are behind doesn't undo another device's work.

import { focusItem, labelled } from "./helpers/builders";
import { CONFIRM_MS, Harness } from "./helpers/harness";
import { LinearWorkspace } from "./helpers/linear-workspace";

const KEY = "testco/TST-1";

function twoDevices() {
  const linear = new Map([["linear-testco", new LinearWorkspace()]]);
  const clock = { now: 1_000_000 };
  const a = new Harness(undefined, { linear, clock });
  const b = new Harness(undefined, { linear, clock });
  return { a, b, linear: linear.get("linear-testco") as LinearWorkspace, clock };
}

/** The vault's file sync copying one device's files to another. */
function syncFiles(from: Harness, to: Harness, files: { focus?: boolean; data?: boolean }) {
  if (files.focus) to.focus.replaceAll(structuredClone(from.focus.items));
  if (files.data) to.data = structuredClone(from.data);
}

describe("a device whose focus file is behind", () => {
  it("doesn't take the label off an item it never saw, so the other device keeps it", async () => {
    const { a, b, linear } = twoDevices();
    linear.tickets = [labelled("TST-1")];

    // A has the ticket in Focus, labelled and synced
    const item = focusItem("TST-1");
    a.focus.items = [item];
    a.data.tickets[KEY] = { issueId: "uuid-testco-TST-1", label: "synced" };
    await a.sync();

    // B wakes: data.json has arrived, focus.md hasn't
    syncFiles(a, b, { data: true });
    await b.sync();
    await b.passTime(CONFIRM_MS);
    await b.passTime(CONFIRM_MS);

    expect(linear.writes).toEqual([]);
    expect(linear.tickets[0].labelIds).toEqual(["label-1"]);

    // A carries on as before
    await a.settle();
    expect(a.focus.items).toEqual([item]);
    expect(a.data.tickets[KEY].label).toBe("synced");
  });

  it("doesn't import a duplicate when it starts before the other device's import arrives", async () => {
    const { a, b, linear } = twoDevices();
    linear.tickets = [labelled("TST-1")];

    // A imports the newly labelled ticket
    await a.settle();
    expect(a.focus.items).toHaveLength(1);

    // B starts with neither file up to date, and sees the label with no item
    await b.sync();
    // Both files arrive within the confirmation wait
    syncFiles(a, b, { focus: true, data: true });
    await b.passTime(CONFIRM_MS);

    expect(b.focus.items).toHaveLength(1);
    expect(b.focus.writes).toEqual([]);
  });

  it("lets the device that saw the items go remove the label", async () => {
    const { a, b, linear } = twoDevices();
    linear.tickets = [labelled("TST-1")];
    const item = focusItem("TST-1");
    a.focus.items = [item];
    a.data.tickets[KEY] = { issueId: "uuid-testco-TST-1", label: "synced" };
    await a.sync();
    syncFiles(a, b, { focus: true, data: true });
    await b.sync();

    // Completed on A
    await a.focus.completeFocusItem(item.id);
    await a.settle();

    expect(linear.writes).toEqual(["remove label TST-1"]);
    expect(a.data.tickets).toEqual({});

    // B catches up and has nothing to do
    syncFiles(a, b, { focus: true, data: true });
    await b.settle();
    expect(linear.writes).toEqual(["remove label TST-1"]);
  });
});
