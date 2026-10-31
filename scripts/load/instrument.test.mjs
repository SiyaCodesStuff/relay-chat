import { test } from "node:test";
import assert from "node:assert/strict";
import { instrument } from "./instrument.mjs";

test("instrumented transactions preserve callback return values and await the complete transaction", async () => {
  const calls = [];
  const db = {
    async transaction(callback) {
      return callback({ insert: async () => ["stored-message"] });
    },
  };
  instrument(db, "transaction", (name, time) => calls.push({ name, time }));
  assert.deepEqual(await db.transaction((tx) => tx.insert()), ["stored-message"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "transaction");
});
test("pg callback queries preserve error/results and pg promise queries preserve rejection", async () => {
  const measured = [];
  const failure = new Error("query fault");
  const client = {
    query(_text, callback) {
      if (callback) return callback(failure, null);
      return Promise.reject(failure);
    },
  };
  instrument(client, "query", (name) => measured.push(name));
  let received;
  client.query("private SQL is not recorded", (error) => {
    received = error;
  });
  assert.equal(received, failure);
  await assert.rejects(client.query("another private query"), (error) => error === failure);
  assert.deepEqual(measured, ["query", "query"]);
});
