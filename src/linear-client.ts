// ABOUTME: Reads from Linear's GraphQL API through Obsidian's requestUrl, one client per API key.
// ABOUTME: Read-only; maps HTTP and GraphQL failures onto a few error kinds the plugin can act on.

import { requestUrl } from "obsidian";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const REQUEST_TIMEOUT_MS = 30_000;
// Tickets asked for in one request when checking states
export const BATCH_SIZE = 50;
// Linear identifiers: an upper-case team key, a dash and a number
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

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
  // Each well-formed identifier asked for → its ticket, or null if Linear says it can't find
  // one (no such ticket, or the key can't see it). Malformed identifiers are left out.
  getTickets(identifiers: string[]): Promise<Map<string, LinearTicket | null>>;
}

const TICKET_FIELDS = `id identifier url title trashed state { type } project { name }`;

/**
 * Every query the plugin sends. scripts/probe-linear.mjs builds the same ones, which
 * tests/probe-linear.test.ts checks.
 */
export const QUERIES = {
  organization: `query { viewer { organization { name urlKey } } }`,
  // One aliased issue(id:) per ticket, t0…tN, with the identifiers passed as $i0…$iN.
  // issue(id:) also accepts the identifier a ticket had before it moved team.
  tickets(count: number): string {
    const indexes = Array.from({ length: count }, (_, index) => index);
    const variables = indexes.map((index) => `$i${index}: String!`).join(", ");
    const fields = indexes
      .map((index) => `t${index}: issue(id: $i${index}) { ${TICKET_FIELDS} }`)
      .join(" ");
    return `query (${variables}) { ${fields} }`;
  },
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

interface GraphqlError {
  message?: string;
  path?: (string | number)[];
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
    // Flow trims project names, so trimmed here too and compared alike
    projectName: node.project?.name.trim() || null,
  };
}

function isNotFound(error: GraphqlError): boolean {
  return /entity not found/i.test(error.message ?? "");
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
    return (await this.getTickets([identifier])).get(identifier) ?? null;
  }

  async getTickets(identifiers: string[]): Promise<Map<string, LinearTicket | null>> {
    const unique = [...new Set(identifiers)].filter((identifier) => IDENTIFIER.test(identifier));
    const results = new Map<string, LinearTicket | null>();
    for (let start = 0; start < unique.length; start += BATCH_SIZE) {
      const batch = unique.slice(start, start + BATCH_SIZE);
      const variables = Object.fromEntries(
        batch.map((identifier, index) => [`i${index}`, identifier])
      );
      const { data, errors } = await this.request<Record<string, TicketNode | null>>(
        QUERIES.tickets(batch.length),
        variables
      );

      // Each "not found" names its alias in its path. Anything else fails the whole check.
      const notFound = new Set<string>();
      const otherErrors = errors.filter((error) => {
        const alias = error.path?.[0];
        if (typeof alias === "string" && isNotFound(error)) {
          notFound.add(alias);
          return false;
        }
        return true;
      });
      if (otherErrors.length > 0) throw errorFromGraphql(otherErrors);

      batch.forEach((identifier, index) => {
        const node = data?.[`t${index}`];
        if (node) results.set(identifier, toTicket(node));
        else if (notFound.has(`t${index}`)) results.set(identifier, null);
        else throw new LinearError("api", `Linear gave no answer for ${identifier}`);
      });
    }
    return results;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data, errors } = await this.request<T>(query, variables);
    if (errors.length > 0) throw errorFromGraphql(errors);
    if (!data) throw new LinearError("api", "Linear returned no data");
    return data;
  }

  /**
   * Send a query and return its data and errors, which can both be present: Linear answers a
   * partly failed query with HTTP 200, the data it could get and an error for each part.
   */
  private async request<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<{ data: T | null; errors: GraphqlError[] }> {
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
    const errors = body?.errors ?? [];
    // Authentication and rate limits fail every part, so they fail the whole request
    if (
      errors.some((error) =>
        ["AUTHENTICATION_ERROR", "RATELIMITED"].includes(error.extensions?.code ?? "")
      )
    ) {
      throw errorFromGraphql(errors);
    }
    if (!body || (response.status >= 400 && errors.length === 0)) {
      throw new LinearError("api", `Linear returned HTTP ${response.status}`);
    }
    return { data: body.data ?? null, errors };
  }
}
