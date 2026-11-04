// ABOUTME: Minimal stand-in for the obsidian module so plugin code can run under Jest.
// ABOUTME: requestUrl is a jest.fn that tests point at recorded Linear responses.

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export const requestUrl = jest.fn<Promise<RequestUrlResponse>, [RequestUrlParam]>();

type Callback = (...data: unknown[]) => unknown;

export class Events {
  private handlers = new Map<string, Set<Callback>>();

  on(name: string, callback: Callback): { name: string; callback: Callback; events: Events } {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(callback);
    this.handlers.set(name, handlers);
    return { name, callback, events: this };
  }

  offref(ref: { name: string; callback: Callback }): void {
    this.handlers.get(ref.name)?.delete(ref.callback);
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const callback of this.handlers.get(name) ?? []) callback(...data);
  }
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class Component {}

/** Plugin with the lifecycle pieces Flow Linear uses; unload() undoes what was registered. */
export class Plugin extends Component {
  commands: { id: string; name: string; callback: () => void }[] = [];
  settingTabs: unknown[] = [];
  stored: unknown = null;
  private eventRefs: { name: string; callback: Callback; events: Events }[] = [];
  private intervals: number[] = [];

  constructor(
    public app: unknown,
    public manifest: unknown = {}
  ) {
    super();
  }

  async loadData(): Promise<unknown> {
    return structuredClone(this.stored);
  }

  async saveData(data: unknown): Promise<void> {
    this.stored = structuredClone(data);
  }

  addCommand(command: { id: string; name: string; callback: () => void }) {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  registerEvent(ref: { name: string; callback: Callback; events: Events }): void {
    this.eventRefs.push(ref);
  }

  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }

  unload(): void {
    for (const ref of this.eventRefs) ref.events.offref(ref);
    for (const id of this.intervals) clearInterval(id);
    (this as unknown as { onunload?: () => void }).onunload?.();
  }
}

/** A bare element with the helpers Obsidian adds to HTMLElement that plugin code uses. */
export class FakeElement {
  children: FakeElement[] = [];
  text = "";
  classes: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(public tag = "div") {}

  createEl(tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
    const el = new FakeElement(tag);
    if (options.cls) el.classes.push(options.cls);
    if (options.text) el.text = options.text;
    this.children.push(el);
    return el;
  }

  createDiv(options: { cls?: string; text?: string } = {}): FakeElement {
    return this.createEl("div", options);
  }

  empty(): void {
    this.children = [];
    Setting.created = Setting.created.filter((setting) => setting.containerEl !== this);
  }

  setText(text: string): void {
    this.text = text;
  }

  addClass(cls: string): void {
    this.classes.push(cls);
  }

  focus(): void {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** All text in this element and its children, for assertions. */
  allText(): string {
    return [this.text, ...this.children.map((child) => child.allText())].join(" ").trim();
  }
}

export class Modal {
  static opened: Modal[] = [];
  contentEl = new FakeElement();
  title = "";
  isOpen = false;
  constructor(public app: unknown) {}
  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  open(): void {
    Modal.opened.push(this);
    this.isOpen = true;
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  close(): void {
    this.isOpen = false;
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
}

export class PluginSettingTab {
  updates = 0;
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
  update(): void {
    this.updates++;
  }
}

type ChangeHandler<T> = (value: T) => unknown;

export class TextComponent {
  inputEl = new FakeElement("input");
  value = "";
  placeholder = "";
  private handler: ChangeHandler<string> = () => {};
  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(handler: ChangeHandler<string>): this {
    this.handler = handler;
    return this;
  }
  /** Type a new value, as the user would. */
  type(value: string): void {
    this.value = value;
    this.handler(value);
  }
}

export class DropdownComponent {
  options: Record<string, string> = {};
  value = "";
  private handler: ChangeHandler<string> = () => {};
  addOption(value: string, display: string): this {
    this.options[value] = display;
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(handler: ChangeHandler<string>): this {
    this.handler = handler;
    return this;
  }
  select(value: string): void {
    this.value = value;
    this.handler(value);
  }
}

export class ButtonComponent {
  text = "";
  cta = false;
  disabled = false;
  private handler: () => unknown = () => {};
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onClick(handler: () => unknown): this {
    this.handler = handler;
    return this;
  }
  /** Click and wait for an async handler to finish. */
  async click(): Promise<void> {
    await this.handler();
  }
}

export class SecretComponent {
  static created: SecretComponent[] = [];
  private handler: ChangeHandler<string> = () => {};
  constructor(
    public app: unknown,
    public containerEl: unknown
  ) {
    SecretComponent.created.push(this);
  }
  setValue(): this {
    return this;
  }
  onChange(handler: ChangeHandler<string>): this {
    this.handler = handler;
    return this;
  }
  choose(name: string): void {
    this.handler(name);
  }
}

/** A settings row; every row made is listed in Setting.created so tests can find it by name. */
export class Setting {
  static created: Setting[] = [];
  name = "";
  desc = "";
  texts: TextComponent[] = [];
  dropdowns: DropdownComponent[] = [];
  buttons: ButtonComponent[] = [];

  constructor(public containerEl: FakeElement) {
    Setting.created.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  addText(build: (text: TextComponent) => unknown): this {
    const text = new TextComponent();
    this.texts.push(text);
    build(text);
    return this;
  }
  addDropdown(build: (dropdown: DropdownComponent) => unknown): this {
    const dropdown = new DropdownComponent();
    this.dropdowns.push(dropdown);
    build(dropdown);
    return this;
  }
  addButton(build: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    this.buttons.push(button);
    build(button);
    return this;
  }
  addComponent(build: (el: FakeElement) => unknown): this {
    build(new FakeElement());
    return this;
  }
}
