import "dotenv/config";

// Printed unconditionally, before any validation, so a missing/misconfigured
// var is diagnosable from logs even if something below throws.
const REQUIRED_VARS = [
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "DB_TABLE",
  "OAUTH_USERNAME",
  "OAUTH_PASSWORD",
];
console.log(
  "[datastore-mcp] booting; required env vars present:",
  Object.fromEntries(REQUIRED_VARS.map((name) => [name, Boolean(process.env[name])]))
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Table names can't be parameterized in SQL, so restrict to a safe identifier
// pattern before it's ever interpolated into a query string.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validatedTableName(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `DB_TABLE "${name}" is not a valid SQL identifier (letters, digits, underscore; must not start with a digit).`
    );
  }
  return name;
}

export const config = {
  publicUrl: optional("PUBLIC_URL", "http://localhost:8080"),
  port: parseInt(optional("PORT", "8080"), 10),

  db: {
    host: optional("DB_HOST", "localhost"),
    port: parseInt(optional("DB_PORT", "3306"), 10),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    table: validatedTableName(required("DB_TABLE")),
    ssl: optional("DB_SSL", "false").toLowerCase() === "true",
  },

  oauth: {
    username: required("OAUTH_USERNAME"),
    password: required("OAUTH_PASSWORD"),
  },
};
