// ABOUTME: Tests the add-ticket and add-workspace modals through Obsidian's UI components.
// ABOUTME: Drives them as a user would: type, choose, click, and check what is saved or shown.

import { FakeElement, SecretComponent, Setting } from "obsidian";
import { AddTicket } from "../src/add-ticket";
import { AddTicketModal } from "../src/add-ticket-modal";
import { readSettings, WorkspaceSettings } from "../src/settings";
import { WorkspaceModal } from "../src/workspace-modal";
import { ticket, workspace } from "./helpers/builders";
import { FocusStore } from "./helpers/focus-store";
import { LinearWorkspace } from "./helpers/linear-workspace";

function row(name: string): Setting {
  const found = Setting.created.find((setting) => setting.name === name);
  if (!found) throw new Error(`No setting named ${name}`);
  return found;
}

// Modal buttons start async work without returning it; let it finish
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function click(text: string): Promise<void> {
  await button(text).click();
  await flush();
}

function button(text: string) {
  for (const setting of Setting.created) {
    const found = setting.buttons.find((b) => b.text === text);
    if (found) return found;
  }
  throw new Error(`No button ${text}`);
}

function errorText(modal: { contentEl: unknown }): string {
  const el = (modal.contentEl as FakeElement).children.find((child) =>
    child.classes.includes("flow-linear-error")
  );
  return el?.text ?? "";
}

beforeEach(() => {
  Setting.created = [];
  SecretComponent.created = [];
});

describe("AddTicketModal", () => {
  function open() {
    const focus = new FocusStore();
    const linear = new LinearWorkspace();
    linear.tickets = [ticket("TST-4", { title: "Ship the release" })];
    const settings = readSettings(null);
    settings.workspaces = [workspace("testco", { defaultSphere: "work" })];
    const addTicket = new AddTicket({
      getFlowApi: () => focus,
      getSettings: () => settings,
      getSecret: () => "key",
      createClient: () => linear,
    });
    const modal = new AddTicketModal({} as never, addTicket, () => focus.getSpheres());
    modal.open();
    return { modal, focus, linear };
  }

  /** Hold the ticket lookup until `release` is called. */
  function holdLookups(linear: LinearWorkspace) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookUp = linear.getTicketByIdentifier.bind(linear);
    const calls = jest.fn();
    linear.getTicketByIdentifier = async (identifier) => {
      calls();
      await gate;
      return lookUp(identifier);
    };
    return { release, calls };
  }

  it("looks the ticket up once however often Find is pressed", async () => {
    const { linear } = open();
    const held = holdLookups(linear);
    const link = row("Ticket link").texts[0];
    link.type("https://linear.app/testco/issue/TST-4");

    void button("Find ticket").click();
    link.inputEl.dispatch("keydown", { key: "Enter", preventDefault() {} });
    void button("Find ticket").click();
    await flush();
    held.release();
    await flush();

    expect(held.calls).toHaveBeenCalledTimes(1);
    expect(row("Wording").texts[0].value).toBe("Ship the release");
  });

  it("adds the ticket once however often Add is pressed", async () => {
    const { focus } = open();
    row("Ticket link").texts[0].type("https://linear.app/testco/issue/TST-4");
    await click("Find ticket");

    const add = button("Add");
    void add.click();
    void add.click();
    row("Wording").texts[0].inputEl.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await flush();

    expect(focus.items).toHaveLength(1);
  });

  it("draws nothing once closed while a lookup is still running", async () => {
    const { modal, linear } = open();
    const held = holdLookups(linear);
    row("Ticket link").texts[0].type("https://linear.app/testco/issue/TST-4");
    void button("Find ticket").click();
    await flush();

    modal.close();
    held.release();
    await flush();

    expect(Setting.created.some((setting) => setting.name === "Wording")).toBe(false);
    expect((modal.contentEl as unknown as FakeElement).children).toEqual([]);
  });

  it("finds the ticket, offers its title and the workspace's sphere, and adds it", async () => {
    const { modal, focus } = open();
    expect((modal as unknown as { title: string }).title).toBe("Add Linear ticket to Focus");

    row("Ticket link").texts[0].type("https://linear.app/testco/issue/TST-4/ship");
    await click("Find ticket");

    const wording = row("Wording").texts[0];
    expect(wording.value).toBe("Ship the release");
    expect(row("Sphere").dropdowns[0].value).toBe("work");
    expect((modal.contentEl as unknown as FakeElement).allText()).toContain("Testco TST-4");

    wording.type("Write the release notes");
    row("Sphere").dropdowns[0].select("personal");
    await click("Add");

    expect(focus.items).toHaveLength(1);
    expect(focus.items[0]).toMatchObject({ text: "Write the release notes", sphere: "personal" });
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  it("finds the ticket when Enter is pressed in the link field", async () => {
    const { modal } = open();
    const link = row("Ticket link").texts[0];
    link.type("https://linear.app/testco/issue/TST-4");
    const event = { key: "Enter", preventDefault: jest.fn() };
    link.inputEl.dispatch("keydown", event);
    await flush();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(row("Wording").texts[0].value).toBe("Ship the release");
    expect(errorText(modal)).toBe("");
  });

  it("shows an unknown workspace inline and adds nothing", async () => {
    const { modal, focus } = open();
    row("Ticket link").texts[0].type("https://linear.app/elsewhere/issue/ELS-1");
    await click("Find ticket");

    expect(errorText(modal)).toBe(
      'The workspace "elsewhere" isn\'t set up. Set up: Testco (testco).'
    );
    expect(focus.items).toEqual([]);
  });

  it("refuses empty wording inline and stays open", async () => {
    const { modal, focus } = open();
    row("Ticket link").texts[0].type("https://linear.app/testco/issue/TST-4");
    await click("Find ticket");
    row("Wording").texts[0].type("  ");
    await click("Add");

    expect(errorText(modal)).toBe("Enter the wording for the Focus item.");
    expect(focus.items).toEqual([]);
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(true);
  });

  it("adds when Enter is pressed in the wording field", async () => {
    const { focus } = open();
    row("Ticket link").texts[0].type("https://linear.app/testco/issue/TST-4");
    await click("Find ticket");
    row("Wording").texts[0].inputEl.dispatch("keydown", { key: "Enter", preventDefault() {} });
    row("Wording").texts[0].inputEl.dispatch("keydown", { key: "a", preventDefault() {} });
    await flush();
    expect(focus.items.map((i) => i.text)).toEqual(["Ship the release"]);
  });
});

describe("WorkspaceModal", () => {
  function open(existing: WorkspaceSettings[] = []) {
    const linear = new LinearWorkspace("testco", "Testco");
    const saved: WorkspaceSettings[] = [];
    const modal = new WorkspaceModal({} as never, {
      existing,
      spheres: ["personal", "work"],
      getSecret: (name) => (name === "linear-testco" ? "key" : null),
      createClient: () => linear,
      onSave: async (ws) => {
        saved.push(ws);
      },
    });
    modal.open();
    return { modal, saved, linear };
  }

  it("explains what the API key is and what the secret's ID is for", () => {
    open();
    const key = row("Linear API key");
    expect(key.desc).toContain("starting lin_api_");
    expect(key.desc).toContain("Read access is enough");
    expect(key.desc).toContain("the ID is just a name for it");
    expect(key.desc).toContain("only the name goes into Flow Linear's synced settings");
  });

  it("checks the key and saves the workspace with Linear's urlKey", async () => {
    const { modal, saved } = open();
    SecretComponent.created[0].choose("linear-testco");
    row("Default sphere").dropdowns[0].select("work");
    await click("Save");

    expect(saved).toEqual([
      {
        urlKey: "testco",
        displayName: "Testco",
        apiKeySecretName: "linear-testco",
        defaultSphere: "work",
      },
    ]);
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  it("uses a typed display name and defaults to Flow's first sphere", async () => {
    const { saved } = open();
    SecretComponent.created[0].choose("linear-testco");
    row("Display name").texts[0].type("Test company");
    await click("Save");
    expect(saved[0]).toMatchObject({ displayName: "Test company", defaultSphere: "personal" });
  });

  it("shows a refused key inline, saves nothing and re-enables Save", async () => {
    const { modal, saved, linear } = open();
    linear.failNext("getOrganization", "auth");
    SecretComponent.created[0].choose("linear-testco");
    await click("Save");

    expect(errorText(modal)).toBe(
      "Couldn't check the key with Linear: getOrganization failed (auth)"
    );
    expect(saved).toEqual([]);
    expect(button("Save").disabled).toBe(false);
  });
});
