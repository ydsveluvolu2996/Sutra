function required(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error(`${name} is required and must be one line`);
  }
  return value;
}

const database = new URL("postgresql://placeholder/");
database.username = required("SUTRA_DB_APP_USER");
database.password = required("SUTRA_DB_APP_PASSWORD");
database.hostname = required("SUTRA_DB_HOST");
database.port = required("SUTRA_DB_PORT");
database.pathname = `/${required("SUTRA_DB_NAME")}`;
database.searchParams.set("sslmode", "require");
process.env.DATABASE_URL = database.toString();

const { main } = await import("./runtime.mjs");
await main();
