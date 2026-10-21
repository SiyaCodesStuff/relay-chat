import { env } from "./env.js";
import { app } from "./app.js";

app.listen(env.API_PORT, env.HOST, () => {
  console.info(`API listening on ${env.HOST}:${env.API_PORT}`);
});
