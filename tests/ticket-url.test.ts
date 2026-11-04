// ABOUTME: Tests parsing Linear ticket URLs into workspace and identifier.
// ABOUTME: Covers accepted forms and the links that must be refused.

import { parseTicketUrl, splitIdentifier, ticketKey } from "../src/ticket-url";

describe("parseTicketUrl", () => {
  it.each([
    "https://linear.app/acme/issue/ABC-123",
    "https://linear.app/acme/issue/ABC-123/",
    "https://linear.app/acme/issue/ABC-123/onboarding-guide",
    "https://linear.app/acme/issue/ABC-123/onboarding-guide?foo=bar",
    "https://linear.app/acme/issue/ABC-123#comment-abc",
    "  https://linear.app/acme/issue/abc-123/onboarding-guide?x=1#y  ",
    "https://linear.app/Acme/issue/ABC-123",
  ])("accepts %s", (url) => {
    expect(parseTicketUrl(url)).toEqual({ urlKey: "acme", identifier: "ABC-123" });
  });

  it.each([
    ["another host", "https://example.com/acme/issue/ABC-123"],
    ["a lookalike host", "https://linear.app.example.com/acme/issue/ABC-123"],
    ["a project URL", "https://linear.app/acme/project/onboarding-1234abcd"],
    ["a team URL", "https://linear.app/acme/team/ABC/active"],
    ["a missing identifier", "https://linear.app/acme/issue/"],
    ["a malformed identifier", "https://linear.app/acme/issue/ABC123"],
    ["extra path parts", "https://linear.app/acme/issue/ABC-123/slug/extra"],
    ["a non-web scheme", "linear://acme/issue/ABC-123"],
    ["text that isn't a URL", "ABC-123"],
    ["an empty string", ""],
  ])("refuses %s", (_, url) => {
    expect(parseTicketUrl(url)).toBeNull();
  });
});

describe("ticketKey", () => {
  it("joins workspace and identifier", () => {
    expect(ticketKey({ urlKey: "acme", identifier: "ABC-123" })).toBe("acme/ABC-123");
  });
});

describe("splitIdentifier", () => {
  it("splits team key and number", () => {
    expect(splitIdentifier("ENG2-14")).toEqual({ teamKey: "ENG2", number: 14 });
  });

  it("refuses malformed identifiers", () => {
    expect(splitIdentifier("ENG")).toBeNull();
  });
});
