// ABOUTME: Parses Linear ticket URLs into workspace and identifier.
// ABOUTME: Accepts links with or without a title slug, query string or fragment.

export interface TicketRef {
  urlKey: string;
  identifier: string; // e.g. "ABC-123"
}

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * Parse `https://linear.app/<urlKey>/issue/<IDENTIFIER>[/<title-slug>]`, with or without a
 * query string or fragment. Returns null for anything else.
 */
export function parseTicketUrl(input: string): TicketRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "linear.app") return null;

  const parts = url.pathname.split("/").filter((part) => part !== "");
  if (parts.length < 3 || parts.length > 4 || parts[1] !== "issue") return null;
  const [urlKey, , identifier] = parts;
  if (!IDENTIFIER_PATTERN.test(identifier)) return null;
  return { urlKey: urlKey.toLowerCase(), identifier: identifier.toUpperCase() };
}
