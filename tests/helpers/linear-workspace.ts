// ABOUTME: In-memory Linear workspace implementing the client interface for sync tests.
// ABOUTME: Holds tickets and labels, records every write, and can be told to fail calls.

import {
  LinearError,
  LinearErrorKind,
  LinearTicket,
  LinearWorkspaceClient,
} from "../../src/linear-client";
import { FOCUS_LABEL_ID } from "./builders";

type Method = keyof LinearWorkspaceClient;

export class LinearWorkspace implements LinearWorkspaceClient {
  tickets: LinearTicket[] = [];
  labels = new Map<string, string>([["flow-focus", FOCUS_LABEL_ID]]); // name → id, workspace-level
  writes: string[] = [];
  calls: Method[] = [];
  private failures = new Map<Method, LinearErrorKind>();
  private nextLabel = 2;

  constructor(
    public urlKey = "testco",
    public name = "Testco"
  ) {}

  failNext(method: Method, kind: LinearErrorKind): void {
    this.failures.set(method, kind);
  }

  private call(method: Method): void {
    this.calls.push(method);
    const kind = this.failures.get(method);
    if (kind) {
      this.failures.delete(method);
      throw new LinearError(kind, `${method} failed (${kind})`);
    }
  }

  async getOrganization() {
    this.call("getOrganization");
    return { name: this.name, urlKey: this.urlKey };
  }

  async getTicketByIdentifier(identifier: string) {
    this.call("getTicketByIdentifier");
    return structuredClone(this.tickets.find((t) => t.identifier === identifier) ?? null);
  }

  async getLabelledTickets(labelId: string) {
    this.call("getLabelledTickets");
    return structuredClone(this.tickets.filter((t) => t.labelIds.includes(labelId)));
  }

  async getTicketsByIds(ids: string[]) {
    this.call("getTicketsByIds");
    return structuredClone(this.tickets.filter((t) => ids.includes(t.id)));
  }

  async getTicketsByIdentifiers(identifiers: string[]) {
    this.call("getTicketsByIdentifiers");
    return structuredClone(this.tickets.filter((t) => identifiers.includes(t.identifier)));
  }

  async findWorkspaceLabel(labelName: string) {
    this.call("findWorkspaceLabel");
    return this.labels.get(labelName.toLowerCase()) ?? null;
  }

  async createWorkspaceLabel(labelName: string) {
    this.call("createWorkspaceLabel");
    const id = `label-${this.nextLabel++}`;
    this.labels.set(labelName.toLowerCase(), id);
    this.writes.push(`create label ${labelName}`);
    return id;
  }

  async addLabel(issueId: string, labelId: string) {
    this.call("addLabel");
    const ticket = this.byId(issueId);
    this.requireLabel(labelId);
    if (!ticket.labelIds.includes(labelId)) ticket.labelIds.push(labelId);
    this.writes.push(`add label ${ticket.identifier}`);
  }

  async removeLabel(issueId: string, labelId: string) {
    this.call("removeLabel");
    const ticket = this.byId(issueId);
    this.requireLabel(labelId);
    ticket.labelIds = ticket.labelIds.filter((id) => id !== labelId);
    this.writes.push(`remove label ${ticket.identifier}`);
  }

  private byId(id: string): LinearTicket {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) throw new LinearError("api", "Entity not found");
    return ticket;
  }

  private requireLabel(labelId: string): void {
    if (![...this.labels.values()].includes(labelId)) {
      throw new LinearError("api", "Label not found");
    }
  }
}
