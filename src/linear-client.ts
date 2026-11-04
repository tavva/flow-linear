// ABOUTME: Reads from Linear's GraphQL API through Obsidian's requestUrl, one client per API key.
// ABOUTME: Read-only; maps HTTP and GraphQL failures onto a few error kinds the plugin can act on.

import { requestUrl } from "obsidian";
import { splitIdentifier } from "./ticket-url";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const REQUEST_TIMEOUT_MS = 30_000;
// Tickets asked for in one query when checking states
export const BATCH_SIZE = 50;

export interface LinearTicket {
  id: string; // UUID
  identifier: string; // e.g. "ABC-123"
  url: string;
  title: string;
  stateType: string; // "triage", "backlog", "unstarted", "started", "completed" or "canceled"
  trashed: boolean;
  projectName: string | null; // The Linear project the ticket belongs to, if any
}

export interface LinearOrganization {
  name: string;
  urlKey: string;
}

export type LinearErrorKind = "network" | "auth" | "rate-limit" | "api";

export class LinearError extends Error {
  constructor(
    readonly kind: LinearErrorKind,
    message: string
  ) {
    super(message);
    this.name = "LinearError";
  }
}

/** What the plugin needs from Linear for one workspace. Nothing here changes Linear. */
export interface LinearWorkspaceClient {
  getOrganization(): Promise<LinearOrganization>;
  // Accepts an identifier the ticket had before it moved team; null if there's no such ticket
  getTicketByIdentifier(identifier: string): Promise<LinearTicket | null>;
  // Each identifier asked for → its ticket, or null if Linear has no such ticket
  getTickets(identifiers: string[]): Promise<Map<string, LinearTicket | null>>;
}

const TICKET_FIELDS = `id identifier url title trashed state { type } project { name }`;

/** Every query the plugin sends. scripts/probe-linear.mjs sends the same ones. */
export const QUERIES = {
  organization: `query { viewer { organization { name urlKey } } }`,
  issue: `query ($id: String!) { issue(id: $id) { ${TICKET_FIELDS} } }`,
  issues: `query ($filter: IssueFilter, $after: String) { issues(filter: $filter, first: ${BATCH_SIZE}, after: $after, includeArchived: true) { nodes { ${TICKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
};

interface TicketNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  trashed?: boolean | null;
  state?: { type: string } | null;
  project?: { name: string } | null;
}

interface IssuePage {
  issues: {
    nodes: TicketNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface GraphqlError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

function toTicket(node: TicketNode): LinearTicket {
  return {
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    title: node.title,
    stateType: node.state?.type ?? "",
    trashed: node.trashed === true,
    projectName: node.project?.name ?? null,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof LinearError && error.kind === "api" && /entity not found/i.test(error.message)
  );
}

function errorFromGraphql(errors: GraphqlError[]): LinearError {
  const codes = errors.map((error) => error.extensions?.code ?? "");
  const message = errors.map((error) => error.message ?? "Unknown error").join("; ");
  if (codes.includes("AUTHENTICATION_ERROR")) return new LinearError("auth", message);
  if (codes.includes("RATELIMITED")) return new LinearError("rate-limit", message);
  return new LinearError("api", message);
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** requestUrl has no timeout of its own; give up on Linear after REQUEST_TIMEOUT_MS. */
function withTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new LinearError("network", "Linear didn't answer within 30 seconds"));
    }, REQUEST_TIMEOUT_MS);
  });
  return Promise.race([request, timeout]).finally(() => window.clearTimeout(timer));
}

export class LinearClient implements LinearWorkspaceClient {
  constructor(private apiKey: string) {}

  async getOrganization(): Promise<LinearOrganization> {
    const data = await this.query<{ viewer: { organization: LinearOrganization } }>(
      QUERIES.organization
    );
    return data.viewer.organization;
  }

  async getTicketByIdentifier(identifier: string): Promise<LinearTicket | null> {
    try {
      const data = await this.query<{ issue: TicketNode | null }>(QUERIES.issue, {
        id: identifier,
      });
      return data.issue ? toTicket(data.issue) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Looks tickets up by team key and number, BATCH_SIZE at a time. One that doesn't turn up
   * that way (it may have moved team) is looked up on its own by identifier.
   */
  async getTickets(identifiers: string[]): Promise<Map<string, LinearTicket | null>> {
    const unique = [...new Set(identifiers)];
    const found = new Map<string, LinearTicket>();
    for (let start = 0; start < unique.length; start += BATCH_SIZE) {
      const conditions = unique.slice(start, start + BATCH_SIZE).flatMap((identifier) => {
        const parts = splitIdentifier(identifier);
        return parts
          ? [{ team: { key: { eq: parts.teamKey } }, number: { eq: parts.number } }]
          : [];
      });
      if (conditions.length === 0) continue;
      for (const ticket of await this.queryIssues({ or: conditions })) {
        found.set(ticket.identifier, ticket);
      }
    }
    const results = new Map<string, LinearTicket | null>();
    for (const identifier of unique) {
      results.set(
        identifier,
        found.get(identifier) ?? (await this.getTicketByIdentifier(identifier))
      );
    }
    return results;
  }

  private async queryIssues(filter: object): Promise<LinearTicket[]> {
    const tickets: LinearTicket[] = [];
    let after: string | null = null;
    do {
      const data: IssuePage = await this.query<IssuePage>(QUERIES.issues, { filter, after });
      tickets.push(...data.issues.nodes.map(toTicket));
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (after);
    return tickets;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response;
    try {
      response = await withTimeout(
        requestUrl({
          url: LINEAR_GRAPHQL_URL,
          method: "POST",
          contentType: "application/json",
          headers: { Authorization: this.apiKey },
          body: JSON.stringify({ query, variables }),
          throw: false,
        })
      );
    } catch (error) {
      if (error instanceof LinearError) throw error;
      throw new LinearError("network", error instanceof Error ? error.message : String(error));
    }

    const body = readJson(response.text) as { data?: T; errors?: GraphqlError[] } | null;
    if (response.status === 401) {
      throw new LinearError("auth", "Linear refused the API key");
    }
    if (response.status === 429) {
      throw new LinearError("rate-limit", "Linear's rate limit was reached");
    }
    if (body?.errors && body.errors.length > 0) {
      throw errorFromGraphql(body.errors);
    }
    if (response.status >= 400 || !body?.data) {
      throw new LinearError("api", `Linear returned HTTP ${response.status}`);
    }
    return body.data;
  }
}
