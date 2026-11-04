// ABOUTME: Read-only probe that sends Linear the exact queries Flow Linear uses and prints the answers.
// ABOUTME: Settles how Linear answers for missing, trashed, moved and hidden tickets. Never sends mutations.

// Usage:
//   LINEAR_API_KEY=... node scripts/probe-linear.mjs \
//     --exists ABC-1 --missing ABC-99999 --trashed ABC-2 --moved OLD-3 [--hidden SEC-4]
//
// Each flag names a ticket identifier; give any of them. The key is read from the environment
// and never printed. `--print-queries <count>` prints the queries without sending anything.

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// Built the same way as QUERIES in src/linear-client.ts; tests/probe-linear.test.ts checks this
const TICKET_FIELDS = "id identifier url title trashed state { type } project { name }";
const QUERIES = {
  organization: "query { viewer { organization { name urlKey } } }",
  tickets(count) {
    const indexes = Array.from({ length: count }, (_, index) => index);
    const variables = indexes.map((index) => `$i${index}: String!`).join(", ");
    const fields = indexes
      .map((index) => `t${index}: issue(id: $i${index}) { ${TICKET_FIELDS} }`)
      .join(" ");
    return `query (${variables}) { ${fields} }`;
  },
};

const ROLES = ["exists", "missing", "trashed", "moved", "hidden"];

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
    projectName: node.project?.name ?? null,
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
      `error: path=${JSON.stringify(error.path)} message=${JSON.stringify(error.message)} code=${JSON.stringify(error.extensions?.code)} type=${JSON.stringify(error.extensions?.type)} userPresentableMessage=${JSON.stringify(error.extensions?.userPresentableMessage)}`
    );
  }
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--print-queries") {
    const count = Number(args[1] ?? 1);
    console.log(
      JSON.stringify({ organization: QUERIES.organization, tickets: QUERIES.tickets(count) })
    );
    return;
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Set LINEAR_API_KEY in the environment");
  const tickets = parseArgs(args);

  const organization = await send(apiKey, QUERIES.organization, {});
  report("viewer organization", organization, organization.body?.data?.viewer?.organization);

  const variables = Object.fromEntries(
    tickets.map(({ identifier }, index) => [`i${index}`, identifier])
  );
  const answer = await send(apiKey, QUERIES.tickets(tickets.length), variables);
  report("tickets: one aliased issue(id:) per identifier", answer, {
    rawData: answer.body?.data === null ? null : typeof answer.body?.data,
    aliases: Object.fromEntries(
      tickets.map(({ role, identifier }, index) => [
        `t${index} ${role} ${identifier}`,
        describeTicket(answer.body?.data?.[`t${index}`] ?? null),
      ])
    ),
  });

  // As the plugin does when a batch fails only with not-found errors: one request per ticket
  for (const { role, identifier } of tickets) {
    const single = await send(apiKey, QUERIES.tickets(1), { i0: identifier });
    const node = single.body?.data?.t0 ?? null;
    const notFound = (single.body?.errors ?? []).every((error) =>
      /entity not found/i.test(error.message ?? "")
    );
    report(`alone: ${role} ${identifier}`, single, {
      rawData: single.body?.data === null ? null : typeof single.body?.data,
      verdict: node ? "ticket" : notFound ? "not visible" : "error",
      ticket: describeTicket(node),
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
