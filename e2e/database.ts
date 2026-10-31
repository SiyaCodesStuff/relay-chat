// Reuse connection credentials, never the integration database itself.
export function e2eDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const configured = environment.DATABASE_URL_E2E;
  const source = configured ?? environment.DATABASE_URL_TEST;
  if (!source) throw new Error("Set DATABASE_URL_E2E or DATABASE_URL_TEST for E2E.");
  let target: URL;
  try {
    target = new URL(source);
    if (!["postgres:", "postgresql:"].includes(target.protocol)) throw new Error();
    if (!configured) target.pathname = "/relay_chat_e2e";
    // Prevent URL options from overriding the database selected by the path.
    if (target.search) throw new Error();
    const name = decodeURIComponent(target.pathname.slice(1)).toLowerCase();
    const otherNames = [environment.DATABASE_URL, environment.DATABASE_URL_TEST]
      .filter((value): value is string => Boolean(value))
      .map((value) => decodeURIComponent(new URL(value).pathname.slice(1)).toLowerCase());
    if (!name || ["postgres", "template0", "template1", ...otherNames].includes(name))
      throw new Error();
  } catch {
    // Never include connection strings or parser errors in test output.
    throw new Error("E2E database must be separate from development and integration databases.");
  }
  return target.href;
}
