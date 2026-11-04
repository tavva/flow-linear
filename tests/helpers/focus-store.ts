// ABOUTME: In-memory Focus list that implements Flow's FlowApi for tests.
// ABOUTME: Reports changes to callbacks by diffing snapshots, as Flow does, including the caller's own writes.

import {
  ExternalFocusItem,
  ExternalFocusItemChanges,
  FlowApi,
  FocusChange,
  FocusChangeCallback,
  NewExternalFocusItem,
} from "../../src/flow-api";

export class FocusStore implements FlowApi {
  readonly apiVersion = 1;
  items: ExternalFocusItem[] = [];
  spheres = ["personal", "work"];
  writes: string[] = [];
  private callbacks = new Map<string, Set<FocusChangeCallback>>();
  private nextId = 1;

  async addFocusItem(input: NewExternalFocusItem): Promise<string> {
    for (const field of ["text", "sphere", "sourceName", "sourceLabel", "externalId"] as const) {
      if (input[field].trim() === "") throw new Error(`Focus item ${field} must not be empty`);
    }
    if (!/^https?:\/\//.test(input.url))
      throw new Error("Focus item url must be an http or https link");
    const id = `focus-${this.nextId++}`;
    this.write(`add ${input.externalId}`, (items) => [
      ...items,
      {
        id,
        text: input.text.trim(),
        sphere: input.sphere,
        addedAt: Date.now(),
        contexts: [],
        external: {
          sourceName: input.sourceName,
          sourceLabel: input.sourceLabel,
          url: input.url,
          externalId: input.externalId,
        },
      },
    ]);
    return id;
  }

  async updateFocusItem(id: string, changes: ExternalFocusItemChanges): Promise<void> {
    this.write(
      `update ${id}`,
      (items) =>
        items.map((item) => {
          if (item.id !== id) return item;
          return {
            ...item,
            text: changes.text ?? item.text,
            sphere: changes.sphere ?? item.sphere,
            external: {
              ...item.external,
              sourceLabel: changes.sourceLabel ?? item.external.sourceLabel,
              url: changes.url ?? item.external.url,
            },
          };
        }),
      id
    );
  }

  async completeFocusItem(id: string): Promise<void> {
    this.write(
      `complete ${id}`,
      (items) =>
        items.map((item) =>
          item.id === id ? { ...item, completedAt: item.completedAt ?? 1000 } : item
        ),
      id
    );
  }

  async removeFocusItem(id: string): Promise<void> {
    this.write(`remove ${id}`, (items) => items.filter((item) => item.id !== id), id);
  }

  async getFocusItems(sourceName: string): Promise<ExternalFocusItem[]> {
    return structuredClone(this.items.filter((item) => item.external.sourceName === sourceName));
  }

  getSpheres(): string[] {
    return [...this.spheres];
  }

  onFocusChange(sourceName: string, callback: FocusChangeCallback): () => void {
    const callbacks = this.callbacks.get(sourceName) ?? new Set();
    callbacks.add(callback);
    this.callbacks.set(sourceName, callbacks);
    return () => callbacks.delete(callback);
  }

  listenerCount(sourceName: string): number {
    return this.callbacks.get(sourceName)?.size ?? 0;
  }

  /** Replace the whole list, as a sync from another device would, and report the changes. */
  replaceAll(items: ExternalFocusItem[]): void {
    this.apply(() => items);
  }

  // Writes to an existing item name it, and fail if it has gone, as Flow's do
  private write(
    description: string,
    change: (items: ExternalFocusItem[]) => ExternalFocusItem[],
    itemId?: string
  ): void {
    if (itemId !== undefined && !this.items.some((item) => item.id === itemId)) {
      throw new Error(`No Focus item with id ${itemId}`);
    }
    this.writes.push(description);
    this.apply(change);
  }

  private apply(change: (items: ExternalFocusItem[]) => ExternalFocusItem[]): void {
    const before = this.items;
    const after = change(structuredClone(before));
    this.items = after;
    const changes: FocusChange[] = [];
    const previous = new Map(before.map((item) => [item.id, item]));
    for (const item of after) {
      const old = previous.get(item.id);
      if (!old) changes.push({ type: "added", item });
      else if (item.completedAt && !old.completedAt) changes.push({ type: "completed", item });
      else if (item.text !== old.text || item.sphere !== old.sphere) {
        changes.push({ type: "edited", item, previous: old });
      }
    }
    for (const item of before) {
      if (!after.some((entry) => entry.id === item.id)) changes.push({ type: "removed", item });
    }
    for (const change of changes) {
      for (const callback of this.callbacks.get(change.item.external.sourceName) ?? []) {
        callback(change);
      }
    }
  }
}
