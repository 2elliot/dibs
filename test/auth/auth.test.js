import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApp } from "../../src/server.js";
import { getCurrentUser, requireUser } from "../../src/auth/index.js";

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const me = (token) =>
  fetch(`${base}/api/me`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test("login with valid credentials returns a token", async () => {
  const res = await login({ email: "alice@example.com", password: "alice-pass" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login with a wrong password or unknown email returns 401", async () => {
  assert.equal((await login({ email: "alice@example.com", password: "nope" })).status, 401);
  assert.equal((await login({ email: "nobody@example.com", password: "x" })).status, 401);
});

test("login with missing fields is rejected", async () => {
  assert.equal((await login({})).status, 400);
});

test("/api/me returns the logged-in user", async () => {
  const { token } = await (await login({ email: "bob@example.com", password: "bob-pass" })).json();
  const res = await me(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "u2", email: "bob@example.com" });
});

test("/api/me without or with an invalid token returns 401", async () => {
  assert.equal((await me()).status, 401);
  assert.equal((await me("bogus")).status, 401);
  const res = await fetch(`${base}/api/me`, { headers: { authorization: "Basic abc" } });
  assert.equal(res.status, 401);
});

test("each login gets its own token", async () => {
  const a = await (await login({ email: "alice@example.com", password: "alice-pass" })).json();
  const b = await (await login({ email: "alice@example.com", password: "alice-pass" })).json();
  assert.notEqual(a.token, b.token);
  assert.equal((await me(a.token)).status, 200);
  assert.equal((await me(b.token)).status, 200);
});

test("getCurrentUser and requireUser work for other routes", async () => {
  const { token } = await (await login({ email: "alice@example.com", password: "alice-pass" })).json();
  const app = express();
  app.get("/helper", (req, res) => res.json({ user: getCurrentUser(req) }));
  app.get("/guarded", requireUser, (req, res) => res.json(req.user));
  const s = app.listen(0);
  await new Promise((resolve) => s.once("listening", resolve));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const auth = { authorization: `Bearer ${token}` };
    assert.deepEqual(await (await fetch(`${url}/helper`, { headers: auth })).json(), {
      user: { id: "u1", email: "alice@example.com" },
    });
    assert.deepEqual(await (await fetch(`${url}/helper`)).json(), { user: null });
    assert.equal((await fetch(`${url}/guarded`)).status, 401);
    const ok = await fetch(`${url}/guarded`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: "u1", email: "alice@example.com" });
  } finally {
    s.close();
  }
});
