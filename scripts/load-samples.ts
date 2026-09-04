import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface SampleTicket {
  id: string;
  subject: string;
  body: string;
}

const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataPath = path.resolve(here, '../data/sample-tickets.json');
  const raw = await readFile(dataPath, 'utf8');
  const tickets = JSON.parse(raw) as SampleTicket[];

  console.log(`Loading ${tickets.length} samples via ${API_BASE}`);

  let created = 0;
  let replayed = 0;
  let conflicts = 0;
  let errors = 0;

  for (const ticket of tickets) {
    const response = await fetch(`${API_BASE}/v1/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ticket),
    });

    const replayedHeader = response.headers.get('idempotent-replayed');
    if (response.status === 202) {
      created += 1;
      console.log(`[created] ${ticket.id}`);
    } else if (response.status === 200 && replayedHeader === 'true') {
      replayed += 1;
      console.log(`[replayed] ${ticket.id}`);
    } else if (response.status === 409) {
      conflicts += 1;
      console.log(`[conflict] ${ticket.id}`);
    } else {
      errors += 1;
      const body = await response.text();
      console.error(`[error] ${ticket.id} status=${response.status} body=${body}`);
    }
  }

  console.log(
    JSON.stringify({ created, replayed, conflicts, errors, total: tickets.length }, null, 2),
  );

  if (errors > 0 || conflicts > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
