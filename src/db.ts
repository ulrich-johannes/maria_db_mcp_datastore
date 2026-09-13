import mariadb from "mariadb";
import { config } from "./config";

const pool = mariadb.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  ssl: config.db.ssl ? {} : undefined,
  connectionLimit: 5,
  // Fail fast and visibly on an unreachable/misconfigured DB instead of
  // hanging past a platform's deploy health-check window.
  connectTimeout: 5000,
  acquireTimeout: 8000,
});

// Table name comes from an env var and is validated as a plain SQL identifier
// in config.ts, so it's safe to interpolate directly (backtick-quoted).
const TABLE = `\`${config.db.table}\``;

export interface StateRow {
  var_name: string;
  description: string | null;
  content: string | null;
  created: Date;
  last_updated: Date;
  deleted: number;
}

export interface StateListItem {
  var_name: string;
  description: string | null;
}

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      \`var_name\`     VARCHAR(255)  NOT NULL,
      \`description\`  VARCHAR(1000) NULL,
      \`content\`      LONGTEXT      NULL,
      \`created\`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_updated\` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`deleted\`      TINYINT(1)    NOT NULL DEFAULT 0,
      PRIMARY KEY (\`var_name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export async function createVar(
  varName: string,
  description: string | null,
  content: string | null
): Promise<StateRow> {
  const existing = await pool.query(
    `SELECT * FROM ${TABLE} WHERE var_name = ? LIMIT 1`,
    [varName]
  );

  if (existing.length > 0 && existing[0].deleted === 0) {
    throw new ConflictError(`Variable "${varName}" already exists.`);
  }

  if (existing.length > 0) {
    // Row was soft-deleted; revive it with the new content.
    await pool.query(
      `UPDATE ${TABLE}
       SET description = ?, content = ?, deleted = 0, created = CURRENT_TIMESTAMP
       WHERE var_name = ?`,
      [description, content, varName]
    );
  } else {
    await pool.query(
      `INSERT INTO ${TABLE} (var_name, description, content) VALUES (?, ?, ?)`,
      [varName, description, content]
    );
  }

  return getVar(varName, false) as Promise<StateRow>;
}

export async function getVar(
  varName: string,
  includeDeleted = false
): Promise<StateRow | null> {
  const rows = await pool.query(
    `SELECT * FROM ${TABLE} WHERE var_name = ? LIMIT 1`,
    [varName]
  );
  if (rows.length === 0) return null;
  const row: StateRow = rows[0];
  if (row.deleted === 1 && !includeDeleted) return null;
  return row;
}

export async function updateVar(
  varName: string,
  updates: { description?: string | null; content?: string | null }
): Promise<StateRow> {
  const current = await getVar(varName, false);
  if (!current) {
    throw new NotFoundError(`Variable "${varName}" does not exist.`);
  }

  const description =
    updates.description !== undefined ? updates.description : current.description;
  const content = updates.content !== undefined ? updates.content : current.content;

  await pool.query(
    `UPDATE ${TABLE} SET description = ?, content = ? WHERE var_name = ?`,
    [description, content, varName]
  );

  return getVar(varName, false) as Promise<StateRow>;
}

export async function deleteVar(varName: string): Promise<void> {
  const current = await getVar(varName, false);
  if (!current) {
    throw new NotFoundError(`Variable "${varName}" does not exist.`);
  }
  await pool.query(`UPDATE ${TABLE} SET deleted = 1 WHERE var_name = ?`, [
    varName,
  ]);
}

export async function listVars(
  includeDeleted = false
): Promise<StateListItem[]> {
  const rows = await pool.query(
    includeDeleted
      ? `SELECT var_name, description FROM ${TABLE} ORDER BY var_name`
      : `SELECT var_name, description FROM ${TABLE} WHERE deleted = 0 ORDER BY var_name`
  );
  return rows.map((r: any) => ({
    var_name: r.var_name,
    description: r.description,
  }));
}
