import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server.js";
import { getCurrentUser } from "../../src/auth/index.js";

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const login = (body) =>
  fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("login with valid credentials returns a token", async () => {
  const res = await login({ email: "alice@example.com", password: "alice-pass" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login with bad credentials returns 401", async () => {
  for (const body of [
    { email: "alice@example.com", password: "wrong" },
    { email: "nobody@example.com", password: "alice-pass" },
    { email: "alice@example.com" },
    {},
  ]) {
    const res = await login(body);
    assert.equal(res.status, 401, JSON.stringify(body));
  }
});

test("GET /api/me returns the logged-in user", async () => {
  const { token } = await (
    await login({ email: "bob@example.com", password: "bob-pass" })
  ).json();
  const res = await fetch(`${base}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "u2", email: "bob@example.com" });
});

test("GET /api/me without a valid token returns 401", async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  const res = await fetch(`${base}/api/me`, {
    headers: { Authorization: "Bearer not-a-token" },
  });
  assert.equal(res.status, 401);
});

test("getCurrentUser reads the bearer token", async () => {
  const { token } = await (
    await login({ email: "alice@example.com", password: "alice-pass" })
  ).json();
  const req = { headers: { authorization: `Bearer ${token}` } };
  assert.deepEqual(getCurrentUser(req), { id: "u1", email: "alice@example.com" });
  assert.equal(getCurrentUser({ headers: {} }), null);
});
