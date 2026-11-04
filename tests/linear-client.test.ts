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
  QUERIES,
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
    expect(sentBody(0).query).toBe(QUERIES.tickets(1));
    expect(sentBody(0).variables).toEqual({ i0: "OLD-2" });
  });

  it("returns null when Linear says there's no such ticket, with HTTP 200 as Linear does", async () => {
    serve([200, "error-entity-not-found"]);
    await expect(client.getTicketByIdentifier("TST-99")).resolves.toBeNull();
  });

  it("trims the project name, as Flow does, and treats a blank one as none", async () => {
    const issue = JSON.parse(fixture("issue-found"));
    issue.data.t0.project = { name: "  Launch " };
    serve([200, JSON.stringify(issue)]);
    expect((await client.getTicketByIdentifier("TST-2"))?.projectName).toBe("Launch");
    issue.data.t0.project = { name: "  " };
    serve([200, JSON.stringify(issue)]);
    expect((await client.getTicketByIdentifier("TST-2"))?.projectName).toBeNull();
  });

  it("passes on other errors", async () => {
    serve([400, "error-invalid-input"]);
    expect((await linearError(client.getTicketByIdentifier("TST-1"))).kind).toBe("api");
  });

  it("asks nothing for a malformed identifier", async () => {
    await expect(client.getTicketByIdentifier("not-an-id")).resolves.toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe("getTickets", () => {
  const allFound = () =>
    JSON.parse(fixture("tickets-all-found")) as {
      data: Record<string, unknown>;
    };
  /** A single-alias answer carrying one ticket from the all-found fixture. */
  const single = (alias: string) => JSON.stringify({ data: { t0: allFound().data[alias] } });

  it("looks every ticket up in one request, one alias each, with the identifiers as variables", async () => {
    serve([200, "tickets-all-found"]);
    const tickets = await new LinearClient("key").getTickets([
      "TST-1",
      "TST-2",
      "TST-3",
      "OLD-7",
      "TST-1",
    ]);

    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(sentBody(0).query).toBe(QUERIES.tickets(4));
    expect(sentBody(0).variables).toEqual({ i0: "TST-1", i1: "TST-2", i2: "TST-3", i3: "OLD-7" });
    expect([...tickets.keys()]).toEqual(["TST-1", "TST-2", "TST-3", "OLD-7"]);
    expect(tickets.get("TST-1")).toMatchObject({ stateType: "started", projectName: "Onboarding" });
    expect(tickets.get("TST-3")?.trashed).toBe(true);
    // A moved ticket comes back under its new identifier
    expect(tickets.get("OLD-7")).toMatchObject({ identifier: "TST-1131", stateType: "completed" });
  });

  it("asks one by one when a ticket isn't found, since that nulls the whole answer", async () => {
    // Linear's real answer: data is null, with one not-found error naming its alias
    serve(
      [200, "tickets-mixed"],
      [200, single("t0")],
      [200, "error-entity-not-found"],
      [200, single("t2")],
      [200, single("t3")]
    );
    const tickets = await new LinearClient("key").getTickets(["TST-1", "TST-99", "TST-3", "OLD-7"]);

    expect(mockRequestUrl).toHaveBeenCalledTimes(5);
    expect(sentBody(1)).toEqual({ query: QUERIES.tickets(1), variables: { i0: "TST-1" } });
    expect(sentBody(2).variables).toEqual({ i0: "TST-99" });
    expect(tickets.get("TST-1")?.identifier).toBe("TST-1");
    expect(tickets.get("TST-99")).toBeNull();
    expect(tickets.get("TST-3")?.trashed).toBe(true);
    expect(tickets.get("OLD-7")?.identifier).toBe("TST-1131");
  });

  it("asks one by one when every alias comes back null instead of data", async () => {
    const answer = JSON.parse(fixture("tickets-mixed"));
    answer.data = { t0: null, t1: null };
    serve([200, JSON.stringify(answer)], [200, single("t0")], [200, "error-entity-not-found"]);
    const tickets = await new LinearClient("key").getTickets(["TST-1", "TST-99"]);
    expect(tickets.get("TST-1")?.identifier).toBe("TST-1");
    expect(tickets.get("TST-99")).toBeNull();
  });

  it("then asks for a ticket it didn't find on its own, until it turns up again", async () => {
    const client = new LinearClient("key");
    serve([200, "tickets-mixed"], [200, single("t0")], [200, "error-entity-not-found"]);
    await client.getTickets(["TST-1", "TST-99"]);
    mockRequestUrl.mockReset();

    // Next check: TST-1 in the batch, TST-99 alone, so it can't null the batch
    serve([200, single("t0")], [200, "error-entity-not-found"]);
    const tickets = await client.getTickets(["TST-1", "TST-99"]);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    expect(sentBody(0).variables).toEqual({ i0: "TST-1" });
    expect(sentBody(1).variables).toEqual({ i0: "TST-99" });
    expect(tickets.get("TST-99")).toBeNull();
    mockRequestUrl.mockReset();

    // It turns up (say the key was given access), so it rejoins the batch afterwards
    serve([200, JSON.stringify({ data: { t0: allFound().data.t1 } })]);
    await client.getTickets(["TST-99"]);
    mockRequestUrl.mockReset();
    serve([200, JSON.stringify({ data: { t0: allFound().data.t0, t1: allFound().data.t1 } })]);
    await client.getTickets(["TST-1", "TST-99"]);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(sentBody(0).variables).toEqual({ i0: "TST-1", i1: "TST-99" });
  });

  it("builds a query with one aliased issue(id:) per ticket", () => {
    expect(QUERIES.tickets(2)).toBe(
      "query ($i0: String!, $i1: String!) { " +
        "t0: issue(id: $i0) { id identifier url title trashed state { type } project { name } } " +
        "t1: issue(id: $i1) { id identifier url title trashed state { type } project { name } } }"
    );
  });

  it("asks in batches of BATCH_SIZE", async () => {
    const identifiers = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `TST-${i + 1}`);
    mockRequestUrl.mockImplementation(async (request) => {
      const { variables } = JSON.parse(request.body as string) as {
        variables: Record<string, string>;
      };
      const data = Object.fromEntries(
        Object.entries(variables).map(([name, identifier]) => [
          `t${name.slice(1)}`,
          {
            id: `id-${identifier}`,
            identifier,
            url: `https://linear.app/testco/issue/${identifier}`,
            title: "T",
            state: { type: "started" },
          },
        ])
      );
      return respond(200, JSON.stringify({ data }));
    });

    const tickets = await new LinearClient("key").getTickets(identifiers);

    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    expect(tickets.size).toBe(BATCH_SIZE + 1);
  });

  it("asks nothing when there are no well-formed identifiers", async () => {
    await expect(client.getTickets([])).resolves.toEqual(new Map());
    // Lower case, no number, or not an identifier at all
    await expect(client.getTickets(["tst-1", "TST", "TST-1 OR 1"])).resolves.toEqual(new Map());
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it("fails the whole lookup on an error that isn't a not-found, without asking one by one", async () => {
    const answer = JSON.parse(fixture("tickets-mixed"));
    answer.errors.push({ message: "Something else went wrong", path: ["t2"] });
    serve([200, JSON.stringify(answer)]);
    const error = await linearError(
      new LinearClient("key").getTickets(["TST-1", "TST-99", "TST-3"])
    );
    expect(error.kind).toBe("api");
    expect(error.message).toBe("Something else went wrong");
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it("fails when a ticket asked for on its own gives another error", async () => {
    serve([200, "tickets-mixed"], [400, "error-invalid-input"]);
    expect((await linearError(new LinearClient("key").getTickets(["TST-1", "TST-99"]))).kind).toBe(
      "api"
    );
  });

  it("fails when an alias comes back empty with no error to say why", async () => {
    serve([200, JSON.stringify({ data: { t0: null } })]);
    const error = await linearError(new LinearClient("key").getTickets(["TST-1"]));
    expect(error.message).toBe("Linear gave no answer for TST-1");
  });

  it("fails the whole lookup when the key is refused or rate-limited, whatever else came back", async () => {
    const answer = JSON.parse(fixture("tickets-mixed"));
    answer.errors.push({ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } });
    serve([200, JSON.stringify(answer)]);
    expect((await linearError(new LinearClient("key").getTickets(["TST-1", "TST-99"]))).kind).toBe(
      "rate-limit"
    );
  });
});

describe("read-only", () => {
  it("sends no mutations", async () => {
    serve([200, "viewer"], [200, "issue-found"], [200, "tickets-all-found"]);
    await client.getOrganization();
    await client.getTicketByIdentifier("TST-2");
    await client.getTickets(["TST-1", "TST-2", "TST-3", "OLD-7"]);
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
