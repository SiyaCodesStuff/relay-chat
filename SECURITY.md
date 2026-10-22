# Security

## Known issues

- `npm audit` reports 4 moderate advisories ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) reached through `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild <=0.24.2`. Scope: development tooling only; `npm audit --omit=dev` reports 0 vulnerabilities. The advisory concerns esbuild's development server, which `drizzle-kit` does not start. The automated "fix" would downgrade `drizzle-kit` to 0.18.1 and is deliberately declined. Action: recheck when `drizzle-kit` ships a release that no longer depends on `@esbuild-kit`.

Development servers, including Vite and `tsx --watch`, must be bound only to localhost and must never be exposed to other machines.
