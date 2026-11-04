// ABOUTME: Read-only probe that sends Linear the exact queries Flow Linear uses and prints the answers.
// ABOUTME: Settles how Linear answers for missing, trashed, moved and hidden tickets. Never sends mutations.

// Usage:
//   LINEAR_API_KEY=... node scripts/probe-linear.mjs \
//     --exists ABC-1 --missing ABC-99999 --trashed ABC-2 --moved OLD-3 [--hidden SEC-4]
//
// Each flag names a ticket identifier; give any of them. The key is read from the environment
// and never printed.

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// The same strings as QUERIES in src/linear-client.ts; tests/probe-linear.test.ts checks this
const QUERIES = {
  organization: "query { viewer { organization { name urlKey } } }",
  issue:
    "query ($id: String!) { issue(id: $id) { id identifier url title trashed state { type } } }",
  issues:
    "query ($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after, includeArchived: true) { nodes { id identifier url title trashed state { type } } pageInfo { hasNextPage endCursor } } }",
};

const ROLES = ["exists", "missing", "trashed", "moved", "hidden"];
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

function parseArgs(argv) {
  const tickets = [];
  for (let i = 0; i < argv.length; i += 2) {
    const role = argv[i].replace(/^--/, "");
    const identifier = argv[i + 1];
    if (!ROLES.includes(role) || !identifier) {
      throw new Error(`Expected --<${ROLES.join("|")}> <IDENTIFIER>, got "${argv[i]}"`);
    }
    tickets.push({ role, identifier: identifier.toUpperCase() });
  }
  if (tickets.length === 0) throw new Error("Give at least one ticket, e.g. --exists ABC-1");
  return tickets;
}

async function send(apiKey, query, variables) {
  if (/^\s*mutation\b/.test(query)) throw new Error("The probe never sends mutations");
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Reported below as a body that isn't JSON
  }
  return { status: response.status, body, text };
}

function describeTicket(node) {
  if (!node) return node;
  return {
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    trashed: node.trashed,
    stateType: node.state?.type,
  };
}

function report(title, { status, body, text }, data) {
  console.log(`\n== ${title}`);
  console.log(`HTTP ${status}`);
  if (!body) {
    console.log(`Body isn't JSON: ${text.slice(0, 300)}`);
    return;
  }
  for (const error of body.errors ?? []) {
    console.log(
      `error: message=${JSON.stringify(error.message)} code=${JSON.stringify(error.extensions?.code)} type=${JSON.stringify(error.extensions?.type)} userPresentableMessage=${JSON.stringify(error.extensions?.userPresentableMessage)}`
    );
  }
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Set LINEAR_API_KEY in the environment");
  const tickets = parseArgs(process.argv.slice(2));

  const organization = await send(apiKey, QUERIES.organization, {});
  report("viewer organization", organization, organization.body?.data?.viewer?.organization);

  const conditions = tickets.flatMap(({ identifier }) => {
    const match = IDENTIFIER.exec(identifier);
    return match ? [{ team: { key: { eq: match[1] } }, number: { eq: Number(match[2]) } }] : [];
  });
  const batch = await send(apiKey, QUERIES.issues, { filter: { or: conditions }, after: null });
  const nodes = batch.body?.data?.issues?.nodes ?? [];
  report("batch: issues(filter: { or: [team key + number] }, includeArchived: true)", batch, {
    returned: nodes.map(describeTicket),
    notReturned: tickets
      .filter(({ identifier }) => !nodes.some((node) => node.identifier === identifier))
      .map(({ role, identifier }) => `${role} ${identifier}`),
    hasNextPage: batch.body?.data?.issues?.pageInfo?.hasNextPage,
  });

  for (const { role, identifier } of tickets) {
    const single = await send(apiKey, QUERIES.issue, { id: identifier });
    report(
      `issue(id: "${identifier}")  [${role}]`,
      single,
      describeTicket(single.body?.data?.issue)
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
