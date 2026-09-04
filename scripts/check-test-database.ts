import 'dotenv/config';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error(
    'TEST_DATABASE_URL is required for integration tests.\n' +
      'Create database loura_test and set TEST_DATABASE_URL=postgres://loura:loura@localhost:5434/loura_test\n' +
      'or start a disposable instance:\n' +
      '  docker compose --profile test up -d postgres-test\n' +
      '  export TEST_DATABASE_URL=postgres://loura:loura@localhost:5434/loura_test',
  );
  process.exit(1);
}

let databaseName: string;
try {
  databaseName = new URL(url).pathname.replace(/^\//, '');
} catch {
  console.error('TEST_DATABASE_URL is not a valid URL');
  process.exit(1);
}

if (!databaseName.endsWith('_test')) {
  console.error(
    `Refusing to run integration tests against database "${databaseName}". ` +
      'The name must end with _test.',
  );
  process.exit(1);
}
