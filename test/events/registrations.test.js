import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { events, store } from "../../src/data.js";
import { createApp } from "../../src/server.js";

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  store.sessions.clear();
  store.registrations.length = 0;
});

after(async () => {
  store.sessions.clear();
  store.registrations.length = 0;
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function login(email = "alice@example.com", password = "alice-pass") {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.match(cookie, /(?:^|; )session=/);
  return cookie;
}

function register({ cookie, eventId = "evt-1", body, headers = {} } = {}) {
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(
    `${baseUrl}/api/events/${encodeURIComponent(eventId)}/registrations`,
    {
      method: "POST",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
}

test("registration requires authentication, even with a supplied userId", async () => {
  const response = await register({ body: { userId: "u1" } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(store.registrations.length, 0);
});

test("authentication is checked before looking up the event", async () => {
  const response = await register({ eventId: "missing-event" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(store.registrations.length, 0);
});

test("an unknown session cannot register", async () => {
  const response = await register({ cookie: "session=invalid-session" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(store.registrations.length, 0);
});

test("login cookies register the current user without a request body", async () => {
  const cookie = await login();
  const response = await register({ cookie });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const registration = await response.json();
  assert.deepEqual(Object.keys(registration).sort(), ["eventId", "id", "userId"]);
  assert.match(
    registration.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(registration.eventId, "evt-1");
  assert.equal(registration.userId, "u1");
  assert.deepEqual(store.registrations, [registration]);
});

test("request body cannot override the user, event, or registration id", async () => {
  const cookie = await login();
  const response = await register({
    cookie,
    body: { id: "forged-id", userId: "u2", eventId: "missing-event" },
  });
  assert.equal(response.status, 201);
  const registration = await response.json();
  assert.equal(registration.userId, "u1");
  assert.equal(registration.eventId, "evt-1");
  assert.notEqual(registration.id, "forged-id");
  assert.deepEqual(store.registrations, [registration]);
});

test("a second registration returns 409 without changing the original", async () => {
  const cookie = await login();
  const first = await register({ cookie });
  assert.equal(first.status, 201);
  const registration = await first.json();
  const duplicate = await register({ cookie });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "Already registered" });
  assert.deepEqual(store.registrations, [registration]);
});

test("a new login session does not let the same user register twice", async () => {
  const first = await register({ cookie: await login() });
  assert.equal(first.status, 201);
  const registration = await first.json();
  const duplicate = await register({ cookie: await login() });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "Already registered" });
  assert.deepEqual(store.registrations, [registration]);
});

test("different users can register for the same event", async () => {
  const alice = await register({ cookie: await login() });
  assert.equal(alice.status, 201);
  const aliceRegistration = await alice.json();
  const bob = await register({
    cookie: await login("bob@example.com", "bob-pass"),
  });
  assert.equal(bob.status, 201);
  const bobRegistration = await bob.json();
  assert.equal(bobRegistration.userId, "u2");
  assert.equal(bobRegistration.eventId, "evt-1");
  assert.notEqual(bobRegistration.id, aliceRegistration.id);
  assert.deepEqual(store.registrations, [aliceRegistration, bobRegistration]);
});

test("uniqueness is scoped to both user and event", async (t) => {
  const otherEvent = { id: "evt-registration-test", title: "Another event" };
  events.push(otherEvent);
  t.after(() => events.splice(events.indexOf(otherEvent), 1));
  const cookie = await login();
  const first = await register({ cookie });
  assert.equal(first.status, 201);
  const firstRegistration = await first.json();
  const second = await register({ cookie, eventId: otherEvent.id });
  assert.equal(second.status, 201);
  const secondRegistration = await second.json();
  assert.equal(secondRegistration.userId, firstRegistration.userId);
  assert.equal(secondRegistration.eventId, otherEvent.id);
  assert.notEqual(secondRegistration.id, firstRegistration.id);
  assert.deepEqual(store.registrations, [firstRegistration, secondRegistration]);
});

test("an authenticated request for an unknown event returns 404", async () => {
  const response = await register({
    cookie: await login(),
    eventId: "missing-event",
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Event not found" });
  assert.equal(store.registrations.length, 0);
});

test("simultaneous requests create only one registration", async () => {
  const cookie = await login();
  const responses = await Promise.all([
    register({ cookie }),
    register({ cookie }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const created = await responses.find((response) => response.status === 201).json();
  const conflict = await responses.find((response) => response.status === 409).json();
  assert.deepEqual(conflict, { error: "Already registered" });
  assert.deepEqual(store.registrations, [created]);
});
