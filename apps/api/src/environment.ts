import { z } from "zod";
import { passwordEnvironmentSchema, resolvePasswordCosts } from "./auth/password-parameters.js";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().url(),
    DATABASE_URL_TEST: z.string().url().optional(),
    REDIS_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32),
    ALLOWED_ORIGINS: z.string().min(1).default("http://127.0.0.1:5173,http://localhost:5173"),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
    SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
  })
  .extend(passwordEnvironmentSchema.shape);

export type AppEnvironment = z.infer<typeof envSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv): AppEnvironment {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration. Check these fields: ${fields.join(", ")}`);
  }

  if (result.data.SESSION_ABSOLUTE_TTL_SECONDS < result.data.SESSION_TTL_SECONDS) {
    throw new Error(
      "Invalid environment configuration. SESSION_ABSOLUTE_TTL_SECONDS must be at least SESSION_TTL_SECONDS.",
    );
  }

  resolvePasswordCosts(result.data.NODE_ENV, {
    memoryCost: result.data.ARGON2_MEMORY_COST,
    timeCost: result.data.ARGON2_TIME_COST,
    parallelism: result.data.ARGON2_PARALLELISM,
  });
  return result.data;
}
