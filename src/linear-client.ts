// ABOUTME: Talks to Linear's GraphQL API through Obsidian's requestUrl, one client per API key.
// ABOUTME: Maps HTTP and GraphQL failures onto a small set of error kinds the sync can act on.

import { requestUrl } from "obsidian";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;

export interface LinearTicket {
  id: string; // UUID
  identifier: string; // e.g. "ABC-123"
  url: string;
  title: string;
  stateType: string;
  labelIds: string[]; // Only the labels the caller asked about, not all the ticket's labels
  trashed: boolean;
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

/**
 * What the sync and the add modal need from Linear for one workspace. Ticket lookups take the
 * label ids to report on each ticket (`labelIds`), so only the plugin's own labels are read.
 */
export interface LinearWorkspaceClient {
  getOrganization(): Promise<LinearOrganization>;
  // Accepts an identifier the ticket had before it moved team; null if there's no such ticket
  getTicketByIdentifier(identifier: string, labelIds: string[]): Promise<LinearTicket | null>;
  getLabelledTickets(labelId: string, labelIds: string[]): Promise<LinearTicket[]>;
  getTicketsByIds(ids: string[], labelIds: string[]): Promise<LinearTicket[]>;
  findWorkspaceLabel(labelName: string): Promise<string | null>;
  hasTeamLabel(labelName: string): Promise<boolean>;
  createWorkspaceLabel(labelName: string): Promise<string>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;
}

// Needs a `$labelIds: [ID!]` variable in the query
const TICKET_FIELDS = `id identifier url title trashed state { type }
  labels(filter: { id: { in: $labelIds } }) { nodes { id } }`;

interface TicketNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  trashed?: boolean | null;
  state?: { type: string } | null;
  labels?: { nodes: { id: string }[] } | null;
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

function isNotFound(error: unknown): boolean {
  return (
    error instanceof LinearError && error.kind === "api" && /entity not found/i.test(error.message)
  );
}

function toTicket(node: TicketNode): LinearTicket {
  return {
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    title: node.title,
    stateType: node.state?.type ?? "",
    labelIds: node.labels?.nodes.map((label) => label.id) ?? [],
    trashed: node.trashed === true,
  };
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
      `query { viewer { organization { name urlKey } } }`
    );
    return data.viewer.organization;
  }

  async getTicketByIdentifier(
    identifier: string,
    labelIds: string[]
  ): Promise<LinearTicket | null> {
    try {
      const data = await this.query<{ issue: TicketNode | null }>(
        `query ($id: String!, $labelIds: [ID!]) { issue(id: $id) { ${TICKET_FIELDS} } }`,
        { id: identifier, labelIds }
      );
      return data.issue ? toTicket(data.issue) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // By id, so a team label that happens to share the name doesn't count
  getLabelledTickets(labelId: string, labelIds: string[]): Promise<LinearTicket[]> {
    return this.queryIssues({ labels: { id: { eq: labelId } } }, labelIds);
  }

  getTicketsByIds(ids: string[], labelIds: string[]): Promise<LinearTicket[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.queryIssues({ id: { in: ids } }, labelIds);
  }

  async findWorkspaceLabel(labelName: string): Promise<string | null> {
    const data = await this.query<{ issueLabels: { nodes: { id: string }[] } }>(
      `query ($name: String!) {
        issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { null: true } }, first: 1) {
          nodes { id }
        }
      }`,
      { name: labelName }
    );
    return data.issueLabels.nodes[0]?.id ?? null;
  }

  async hasTeamLabel(labelName: string): Promise<boolean> {
    const data = await this.query<{ issueLabels: { nodes: { id: string }[] } }>(
      `query ($name: String!) {
        issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { null: false } }, first: 1) {
          nodes { id }
        }
      }`,
      { name: labelName }
    );
    return data.issueLabels.nodes.length > 0;
  }

  async createWorkspaceLabel(labelName: string): Promise<string> {
    const data = await this.query<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string } | null };
    }>(
      `mutation ($name: String!) {
        issueLabelCreate(input: { name: $name }) { success issueLabel { id } }
      }`,
      { name: labelName }
    );
    const label = data.issueLabelCreate.issueLabel;
    if (!data.issueLabelCreate.success || !label) {
      throw new LinearError("api", `Linear didn't create the label "${labelName}"`);
    }
    return label.id;
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    const data = await this.query<{ issueAddLabel: { success: boolean } }>(
      `mutation ($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId }
    );
    if (!data.issueAddLabel.success) {
      throw new LinearError("api", "Linear didn't add the label");
    }
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    const data = await this.query<{ issueRemoveLabel: { success: boolean } }>(
      `mutation ($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId }
    );
    if (!data.issueRemoveLabel.success) {
      throw new LinearError("api", "Linear didn't remove the label");
    }
  }

  private async queryIssues(filter: object, labelIds: string[]): Promise<LinearTicket[]> {
    const tickets: LinearTicket[] = [];
    let after: string | null = null;
    do {
      const data: IssuePage = await this.query<IssuePage>(
        `query ($filter: IssueFilter, $after: String, $labelIds: [ID!]) {
          issues(filter: $filter, first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
            nodes { ${TICKET_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after, labelIds }
      );
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
