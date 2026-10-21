import express from "express";

export const app = express();

app.disable("x-powered-by");
app.get("/healthz", (_request, response) => {
  response.status(200).json({ status: "ok" });
});
