/**
 * Environment setup (not a migration): create the read-only role and grant it
 * SELECT. The role name and password come from DATABASE_URL_READONLY, so no
 * password lives in the repo. Safe to run repeatedly.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

export async function setupRoles(
  adminUrl: string,
  readonlyUrl: string,
  rolesSqlPath = path.join(process.cwd(), "db/setup/roles.sql"),
): Promise<{ role: string }> {
  const ro = new URL(readonlyUrl);
  const role = decodeURIComponent(ro.username);
  const password = decodeURIComponent(ro.password);
  if (!role || !password) {
    throw new Error("DATABASE_URL_READONLY must include a user and password.");
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const owner = (await client.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    if (owner === role) {
      throw new Error("DATABASE_URL_READONLY must use a different user than DATABASE_URL_ADMIN.");
    }
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    const ident = client.escapeIdentifier(role);
    const pw = client.escapeLiteral(password);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE ${ident} LOGIN PASSWORD ${pw}`);
    } else {
      await client.query(`ALTER ROLE ${ident} LOGIN PASSWORD ${pw}`);
    }
    // A read-only role must be unable to write even if defaults change later.
    await client.query(`ALTER ROLE ${ident} SET default_transaction_read_only = on`);
    const sql = (await readFile(rolesSqlPath, "utf8"))
      .replaceAll(":ro_role", ident)
      .replaceAll(":owner_role", client.escapeIdentifier(owner));
    await client.query(sql);
    return { role };
  } finally {
    await client.end();
  }
}
