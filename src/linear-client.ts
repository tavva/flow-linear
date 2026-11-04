// ABOUTME: Talks to Linear's GraphQL API through Obsidian's requestUrl, one client per API key.
// ABOUTME: Maps HTTP and GraphQL failures onto a small set of error kinds the sync can act on.

import { requestUrl } from "obsidian";
import { splitIdentifier } from "./ticket-url";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;

export interface LinearTicket {
  id: string; // UUID
  identifier: string; // e.g. "ABC-123"
  url: string;
  title: string;
  stateType: string;
  labelIds: string[];
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

/** What the sync and the add modal need from Linear for one workspace. */
export interface LinearWorkspaceClient {
  getOrganization(): Promise<LinearOrganization>;
  getTicketByIdentifier(identifier: string): Promise<LinearTicket | null>;
  getLabelledTickets(labelId: string): Promise<LinearTicket[]>;
  getTicketsByIds(ids: string[]): Promise<LinearTicket[]>;
  getTicketsByIdentifiers(identifiers: string[]): Promise<LinearTicket[]>;
  findWorkspaceLabel(labelName: string): Promise<string | null>;
  createWorkspaceLabel(labelName: string): Promise<string>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;
}

const TICKET_FIELDS = `id identifier url title trashed state { type } labels { nodes { id } }`;

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

export class LinearClient implements LinearWorkspaceClient {
  constructor(private apiKey: string) {}

  async getOrganization(): Promise<LinearOrganization> {
    const data = await this.query<{ viewer: { organization: LinearOrganization } }>(
      `query { viewer { organization { name urlKey } } }`
    );
    return data.viewer.organization;
  }

  async getTicketByIdentifier(identifier: string): Promise<LinearTicket | null> {
    const tickets = await this.getTicketsByIdentifiers([identifier]);
    return tickets.find((ticket) => ticket.identifier === identifier) ?? null;
  }

  // By id, so a team label that happens to share the name doesn't count
  getLabelledTickets(labelId: string): Promise<LinearTicket[]> {
    return this.queryIssues({ labels: { id: { eq: labelId } } });
  }

  getTicketsByIds(ids: string[]): Promise<LinearTicket[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.queryIssues({ id: { in: ids } });
  }

  getTicketsByIdentifiers(identifiers: string[]): Promise<LinearTicket[]> {
    const conditions = identifiers.flatMap((identifier) => {
      const parts = splitIdentifier(identifier);
      if (!parts) return [];
      return [{ team: { key: { eq: parts.teamKey } }, number: { eq: parts.number } }];
    });
    if (conditions.length === 0) return Promise.resolve([]);
    return this.queryIssues({ or: conditions });
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

  private async queryIssues(filter: object): Promise<LinearTicket[]> {
    const tickets: LinearTicket[] = [];
    let after: string | null = null;
    do {
      const data: IssuePage = await this.query<IssuePage>(
        `query ($filter: IssueFilter, $after: String) {
          issues(filter: $filter, first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
            nodes { ${TICKET_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after }
      );
      tickets.push(...data.issues.nodes.map(toTicket));
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (after);
    return tickets;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response;
    try {
      response = await requestUrl({
        url: LINEAR_GRAPHQL_URL,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }),
        throw: false,
      });
    } catch (error) {
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
