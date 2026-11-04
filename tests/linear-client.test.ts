// ABOUTME: Tests the Linear client's request shape, response parsing and error mapping.
// ABOUTME: Responses come from recorded fixtures in tests/fixtures, served through requestUrl.

import { readFileSync } from "fs";
import { join } from "path";
import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  LINEAR_GRAPHQL_URL,
  LinearClient,
  LinearError,
  REQUEST_TIMEOUT_MS,
} from "../src/linear-client";

const mockRequestUrl = requestUrl as unknown as jest.Mock<
  Promise<RequestUrlResponse>,
  [RequestUrlParam]
>;

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8");
}

function respond(status: number, text: string): RequestUrlResponse {
  return {
    status,
    text,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    get json() {
      return JSON.parse(text);
    },
  };
}

function serve(...responses: [number, string][]): void {
  for (const [status, name] of responses) {
    mockRequestUrl.mockResolvedValueOnce(
      respond(status, /^[{<]/.test(name) ? name : fixture(name))
    );
  }
}

function sentBody(call: number): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(mockRequestUrl.mock.calls[call][0].body as string);
}

async function linearError(promise: Promise<unknown>): Promise<LinearError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinearError);
    return error as LinearError;
  }
  throw new Error("Expected the call to fail");
}

const client = new LinearClient("lin_api_test");

beforeEach(() => {
  mockRequestUrl.mockReset();
});

describe("requests", () => {
  it("posts GraphQL to Linear with the key and without throwing on HTTP errors", async () => {
    serve([200, "viewer"]);
    await client.getOrganization();
    const request = mockRequestUrl.mock.calls[0][0];
    expect(request.url).toBe(LINEAR_GRAPHQL_URL);
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ Authorization: "lin_api_test" });
    expect(request.contentType).toBe("application/json");
    expect(request.throw).toBe(false);
  });
});

describe("getOrganization", () => {
  it("returns the organisation's name and urlKey", async () => {
    serve([200, "viewer"]);
    await expect(client.getOrganization()).resolves.toEqual({ name: "Testco", urlKey: "testco" });
  });
});

describe("getLabelledTickets", () => {
  it("follows pagination and parses tickets", async () => {
    serve([200, "labelled-page-1"], [200, "labelled-page-2"]);
    const tickets = await client.getLabelledTickets("label-uuid-1", ["label-uuid-1"]);

    expect(tickets).toEqual([
      {
        id: "0b5c3e0a-1111-4c55-9a1e-000000000001",
        identifier: "TST-1",
        url: "https://linear.app/testco/issue/TST-1/write-the-onboarding-guide",
        title: "Write the onboarding guide",
        stateType: "started",
        labelIds: ["label-uuid-1", "label-uuid-bug"],
        trashed: false,
      },
      {
        id: "0b5c3e0a-1111-4c55-9a1e-000000000002",
        identifier: "TST-2",
        url: "https://linear.app/testco/issue/TST-2/fix-the-login-page",
        title: "Fix the login page",
        stateType: "unstarted",
        labelIds: ["label-uuid-1"],
        trashed: false,
      },
    ]);
    expect(sentBody(0).variables).toEqual({
      filter: { labels: { id: { eq: "label-uuid-1" } } },
      after: null,
      labelIds: ["label-uuid-1"],
    });
    // Only the plugin's labels are read from each ticket
    expect(sentBody(0).query).toContain("labels(filter: { id: { in: $labelIds } })");
    expect(sentBody(1).variables.after).toBe("cursor-1");
  });
});

describe("getTicketsByIds", () => {
  it("asks for nothing when there are no ids", async () => {
    await expect(client.getTicketsByIds([], [])).resolves.toEqual([]);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it("filters by id and reports trashed tickets", async () => {
    serve([200, "tracked-with-trashed"]);
    const tickets = await client.getTicketsByIds(["a", "0b5c3e0a-1111-4c55-9a1e-000000000003"], []);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].trashed).toBe(true);
    expect(sentBody(0).variables.filter).toEqual({
      id: { in: ["a", "0b5c3e0a-1111-4c55-9a1e-000000000003"] },
    });
  });

  it("returns an empty list when none of the tickets exist", async () => {
    serve([200, "no-issues"]);
    await expect(client.getTicketsByIds(["gone"], [])).resolves.toEqual([]);
  });
});

describe("getTicketByIdentifier", () => {
  it("looks the ticket up by identifier, which Linear also accepts for old identifiers", async () => {
    serve([200, "issue-found"]);
    const ticket = await client.getTicketByIdentifier("OLD-2", ["label-uuid-1"]);
    expect(ticket?.identifier).toBe("TST-2");
    expect(sentBody(0).query).toContain("issue(id: $id)");
    expect(sentBody(0).variables).toEqual({ id: "OLD-2", labelIds: ["label-uuid-1"] });
  });

  it("returns null when Linear says there's no such ticket", async () => {
    serve([400, "error-entity-not-found"]);
    await expect(client.getTicketByIdentifier("TST-99", [])).resolves.toBeNull();
  });

  it("passes on other errors", async () => {
    serve([400, "error-invalid-input"]);
    expect((await linearError(client.getTicketByIdentifier("TST-1", []))).kind).toBe("api");
  });
});

describe("labels", () => {
  it("finds a workspace-level label by name", async () => {
    serve([200, "label-found"]);
    await expect(client.findWorkspaceLabel("flow-focus")).resolves.toBe("label-uuid-1");
    expect(sentBody(0).query).toContain("team: { null: true }");
    expect(sentBody(0).variables).toEqual({ name: "flow-focus" });
  });

  it("returns null when the workspace has no such label", async () => {
    serve([200, "label-missing"]);
    await expect(client.findWorkspaceLabel("flow-focus")).resolves.toBeNull();
  });

  it("detects a team label with the name", async () => {
    serve([200, "label-found"], [200, "label-missing"]);
    await expect(client.hasTeamLabel("flow-focus")).resolves.toBe(true);
    expect(sentBody(0).query).toContain("team: { null: false }");
    await expect(client.hasTeamLabel("flow-focus")).resolves.toBe(false);
  });

  it("creates a workspace-level label without a team", async () => {
    serve([200, "label-created"]);
    await expect(client.createWorkspaceLabel("flow-focus")).resolves.toBe("label-uuid-new");
    expect(sentBody(0).query).toContain("issueLabelCreate(input: { name: $name })");
  });

  it("fails when Linear doesn't create the label", async () => {
    serve([
      200,
      JSON.stringify({ data: { issueLabelCreate: { success: false, issueLabel: null } } }),
    ]);
    expect((await linearError(client.createWorkspaceLabel("flow-focus"))).kind).toBe("api");
  });

  it("adds and removes one label by id", async () => {
    serve([200, "label-added"], [200, "label-removed"]);
    await client.addLabel("issue-1", "label-1");
    await client.removeLabel("issue-1", "label-1");
    expect(sentBody(0).query).toContain("issueAddLabel(id: $id, labelId: $labelId)");
    expect(sentBody(1).query).toContain("issueRemoveLabel(id: $id, labelId: $labelId)");
    expect(sentBody(1).variables).toEqual({ id: "issue-1", labelId: "label-1" });
  });

  it("fails when Linear reports the label change didn't happen", async () => {
    serve([200, "label-not-removed"]);
    expect((await linearError(client.removeLabel("issue-1", "label-1"))).kind).toBe("api");
    serve([200, JSON.stringify({ data: { issueAddLabel: { success: false } } })]);
    expect((await linearError(client.addLabel("issue-1", "label-1"))).kind).toBe("api");
  });
});

describe("errors", () => {
  it("maps HTTP 401 to an auth error", async () => {
    serve([401, "error-authentication"]);
    expect((await linearError(client.getOrganization())).kind).toBe("auth");
  });

  it("maps an authentication GraphQL error to an auth error", async () => {
    serve([400, "error-authentication"]);
    const error = await linearError(client.getOrganization());
    expect(error.kind).toBe("auth");
    expect(error.message).toBe("Authentication required, not authenticated");
  });

  it("maps HTTP 429 to a rate-limit error", async () => {
    serve([429, "{}"]);
    expect((await linearError(client.getOrganization())).kind).toBe("rate-limit");
  });

  it("maps a RATELIMITED GraphQL error to a rate-limit error", async () => {
    serve([400, "error-ratelimited"]);
    expect((await linearError(client.getOrganization())).kind).toBe("rate-limit");
  });

  it("maps other GraphQL errors to an api error with Linear's message", async () => {
    serve([400, "error-invalid-input"]);
    const error = await linearError(client.getLabelledTickets("label-uuid-1", []));
    expect(error.kind).toBe("api");
    expect(error.message).toBe("Argument Validation Error");
  });

  it("maps an HTTP error without a GraphQL body to an api error", async () => {
    serve([502, "<html>Bad gateway</html>"]);
    const error = await linearError(client.getOrganization());
    expect(error.kind).toBe("api");
    expect(error.message).toBe("Linear returned HTTP 502");
  });

  it("gives up on a request after 30 seconds", async () => {
    jest.useFakeTimers();
    mockRequestUrl.mockReturnValueOnce(new Promise(() => {}) as never);
    const pending = linearError(client.getOrganization());
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    const error = await pending;
    expect(error.kind).toBe("network");
    expect(error.message).toBe("Linear didn't answer within 30 seconds");
    jest.useRealTimers();
  });

  it("maps a failed request to a network error", async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"));
    const error = await linearError(client.getOrganization());
    expect(error.kind).toBe("network");
    expect(error.message).toBe("net::ERR_INTERNET_DISCONNECTED");
  });
});
