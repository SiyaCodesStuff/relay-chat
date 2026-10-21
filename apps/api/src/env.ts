import { parseEnvironment } from "./environment.js";

export const env = (() => {
  try {
    return parseEnvironment(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid environment configuration.");
    process.exit(1);
  }
})();
