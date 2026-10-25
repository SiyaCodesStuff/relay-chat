import { z } from "zod";

// Preserve argon2's existing defaults as the minimum outside tests.
export const defaultPasswordCosts = Object.freeze({
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
});
export type PasswordCosts = { memoryCost: number; timeCost: number; parallelism: number };
export const passwordEnvironmentSchema = z.object({
  ARGON2_MEMORY_COST: z.coerce.number().int().min(8).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(4),
});

export function resolvePasswordCosts(
  nodeEnv: string,
  costs: Partial<PasswordCosts> = {},
): PasswordCosts {
  const result = passwordEnvironmentSchema.safeParse({
    ARGON2_MEMORY_COST: costs.memoryCost,
    ARGON2_TIME_COST: costs.timeCost,
    ARGON2_PARALLELISM: costs.parallelism,
  });
  if (!result.success)
    throw new Error(
      "Invalid Argon2 configuration. Check ARGON2_MEMORY_COST, ARGON2_TIME_COST, ARGON2_PARALLELISM.",
    );
  const {
    ARGON2_MEMORY_COST: memoryCost,
    ARGON2_TIME_COST: timeCost,
    ARGON2_PARALLELISM: parallelism,
  } = result.data;
  if (memoryCost < 8 * parallelism)
    throw new Error(
      "Invalid Argon2 configuration. ARGON2_MEMORY_COST must be at least eight times ARGON2_PARALLELISM.",
    );
  if (nodeEnv !== "test" && (memoryCost < 65_536 || timeCost < 3 || parallelism < 4)) {
    throw new Error(
      "Invalid Argon2 configuration. Only NODE_ENV=test permits parameters below the security minimums.",
    );
  }
  return { memoryCost, timeCost, parallelism };
}
