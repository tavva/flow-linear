// ABOUTME: Tests the Linear client's request shape, response parsing and error mapping.
// ABOUTME: Responses come from recorded fixtures in tests/fixtures, served through requestUrl.

import { readFileSync } from "fs";
import { join } from "path";
import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  LINEAR_GRAPHQL_URL,
  LinearClient,
  BATCH_SIZE,
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

describe("getTicketByIdentifier", () => {
  it("looks the ticket up by identifier, which Linear also accepts for old identifiers", async () => {
    serve([200, "issue-found"]);
    const ticket = await client.getTicketByIdentifier("OLD-2");
    expect(ticket).toEqual({
      id: "0b5c3e0a-1111-4c55-9a1e-000000000002",
      identifier: "TST-2",
      url: "https://linear.app/testco/issue/TST-2/fix-the-login-page",
      title: "Fix the login page",
      stateType: "unstarted",
      trashed: false,
      projectName: "Login revamp",
    });
    expect(sentBody(0).query).toContain("issue(id: $id)");
    expect(sentBody(0).variables).toEqual({ id: "OLD-2" });
  });

  it("returns null when Linear says there's no such ticket", async () => {
    serve([400, "error-entity-not-found"]);
    await expect(client.getTicketByIdentifier("TST-99")).resolves.toBeNull();
  });

  it("passes on other errors", async () => {
    serve([400, "error-invalid-input"]);
    expect((await linearError(client.getTicketByIdentifier("TST-1"))).kind).toBe("api");
  });
});

describe("getTickets", () => {
  it("looks tickets up in one query by team key and number", async () => {
    serve([200, "issues-batch"], [400, "error-entity-not-found"]);
    const tickets = await client.getTickets(["TST-1", "TST-3", "TST-1", "TST-9"]);

    expect(sentBody(0).variables).toEqual({
      filter: {
        or: [
          { team: { key: { eq: "TST" } }, number: { eq: 1 } },
          { team: { key: { eq: "TST" } }, number: { eq: 3 } },
          { team: { key: { eq: "TST" } }, number: { eq: 9 } },
        ],
      },
      after: null,
    });
    expect(sentBody(0).query).toContain("includeArchived: true");
    expect([...tickets.keys()]).toEqual(["TST-1", "TST-3", "TST-9"]);
    expect(tickets.get("TST-1")?.stateType).toBe("completed");
    expect(tickets.get("TST-3")?.trashed).toBe(true);
    // A ticket with no project, and one whose response leaves the field out
    expect(tickets.get("TST-1")?.projectName).toBeNull();
    expect(tickets.get("TST-3")?.projectName).toBeNull();
    expect(sentBody(0).query).toContain("project { name }");
    // Missing from the batch, then not found on its own either
    expect(sentBody(1).variables).toEqual({ id: "TST-9" });
    expect(tickets.get("TST-9")).toBeNull();
  });

  it("finds a ticket that moved team by looking its old identifier up on its own", async () => {
    serve([200, "no-issues"], [200, "issue-found"]);
    const tickets = await client.getTickets(["OLD-2"]);
    expect(tickets.get("OLD-2")?.identifier).toBe("TST-2");
  });

  it("follows pagination", async () => {
    serve([200, "issues-page-1"], [200, "issues-page-2"]);
    const tickets = await client.getTickets(["TST-1", "TST-2"]);
    expect(sentBody(1).variables.after).toBe("cursor-1");
    expect(tickets.get("TST-2")?.title).toBe("Fix the login page");
  });

  it("asks in batches", async () => {
    const identifiers = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `TST-${i + 1}`);
    mockRequestUrl.mockImplementation(async (request) => {
      const { variables } = JSON.parse(request.body as string);
      const nodes = (variables.filter.or as { number: { eq: number } }[]).map(({ number }) => ({
        id: `id-${number.eq}`,
        identifier: `TST-${number.eq}`,
        url: `https://linear.app/testco/issue/TST-${number.eq}`,
        title: "T",
        state: { type: "started" },
      }));
      return respond(
        200,
        JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false } } } })
      );
    });

    const tickets = await client.getTickets(identifiers);

    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    expect(tickets.size).toBe(BATCH_SIZE + 1);
  });

  it("asks for nothing when there are no identifiers", async () => {
    await expect(client.getTickets([])).resolves.toEqual(new Map());
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it("looks a malformed identifier up on its own", async () => {
    serve([400, "error-entity-not-found"]);
    const tickets = await client.getTickets(["nonsense"]);
    expect(tickets.get("nonsense")).toBeNull();
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });
});

describe("read-only", () => {
  it("sends no mutations", async () => {
    serve(
      [200, "viewer"],
      [200, "issue-found"],
      [200, "issues-batch"],
      [400, "error-entity-not-found"]
    );
    await client.getOrganization();
    await client.getTicketByIdentifier("TST-2");
    await client.getTickets(["TST-1", "TST-9"]);
    for (const [request] of mockRequestUrl.mock.calls) {
      expect(JSON.parse(request.body as string).query).not.toMatch(/\bmutation\b/);
    }
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
    const error = await linearError(client.getTicketByIdentifier("TST-1"));
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
