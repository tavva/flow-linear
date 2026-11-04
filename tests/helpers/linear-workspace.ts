// ABOUTME: In-memory Linear workspace implementing the read-only client interface for tests.
// ABOUTME: Holds tickets, records which lookups were made, and can be told to fail calls.

import {
  LinearError,
  LinearErrorKind,
  LinearTicket,
  LinearWorkspaceClient,
} from "../../src/linear-client";

type Method = keyof LinearWorkspaceClient;

export class LinearWorkspace implements LinearWorkspaceClient {
  tickets: LinearTicket[] = [];
  oldIdentifiers = new Map<string, string>(); // Identifier a ticket had before moving → its id
  calls: Method[] = [];
  private failures = new Map<Method, LinearErrorKind>();

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

  private find(identifier: string): LinearTicket | null {
    const ticket = this.tickets.find(
      (t) => t.identifier === identifier || this.oldIdentifiers.get(identifier) === t.id
    );
    return ticket ? structuredClone(ticket) : null;
  }

  async getOrganization() {
    this.call("getOrganization");
    return { name: this.name, urlKey: this.urlKey };
  }

  async getTicketByIdentifier(identifier: string) {
    this.call("getTicketByIdentifier");
    return this.find(identifier);
  }

  async getTickets(identifiers: string[]) {
    this.call("getTickets");
    return new Map(identifiers.map((identifier) => [identifier, this.find(identifier)]));
  }
}
