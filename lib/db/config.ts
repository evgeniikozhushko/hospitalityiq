/**
 * Database connection settings. Kept apart from lib/env.ts so database scripts
 * do not need an OpenAI key. Three separate URLs on purpose:
 *   ADMIN     migrations and imports (writes)
 *   READONLY  statistics queries
 *   TEST      disposable instance for integration tests
 * Never use a plain DATABASE_URL: hosts often set it to owner credentials.
 */
export type DbUrls = {
  admin?: string;
  readonly?: string;
  test?: string;
};

export function dbUrls(e: Record<string, string | undefined> = process.env): DbUrls {
  const get = (k: string) => (e[k] && e[k]!.trim() !== "" ? e[k]!.trim() : undefined);
  return {
    admin: get("DATABASE_URL_ADMIN"),
    readonly: get("DATABASE_URL_READONLY"),
    test: get("DATABASE_URL_TEST"),
  };
}

export function requireUrl(name: keyof DbUrls, urls: DbUrls = dbUrls()): string {
  const v = urls[name];
  if (!v) {
    const envName = `DATABASE_URL_${name.toUpperCase()}`;
    throw new Error(`${envName} is not set. Copy the database section of .env.example to .env.local.`);
  }
  return v;
}
