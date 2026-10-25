import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");

function browser(fetch) {
  const elements = Object.fromEntries(
    ["login-form", "login-button", "register-button", "status"].map((id) => [id, {
      disabled: false,
      textContent: "",
      listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
    }]),
  );
  elements["login-form"].elements = {
    email: { value: "alice@example.com" },
    password: { value: "alice-pass" },
  };
  elements["register-button"].dataset = { eventId: "evt-1" };
  vm.runInNewContext(source, {
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    fetch,
  });
  return {
    elements,
    login: () => elements["login-form"].listeners.submit({ preventDefault() {} }),
    register: () => elements["register-button"].listeners.click(),
    status: () => elements.status.textContent,
  };
}

test("login submits credentials and Register uses the event ID and cookie session", async () => {
  const calls = [];
  const page = browser(async (url, options) => {
    calls.push({ url, options });
    return { status: calls.length === 1 ? 200 : 201 };
  });
  await page.login();
  assert.equal(page.status(), "Logged in");
  assert.equal(page.elements["login-form"].elements.password.value, "");
  page.elements["register-button"].dataset.eventId = "event /2";
  await page.register();
  assert.equal(page.status(), "Registered");
  assert.equal(calls[0].url, "/api/login");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email: "alice@example.com", password: "alice-pass",
  });
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[1].url, "/api/events/event%20%2F2/registrations");
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers?.Authorization, undefined);
  }
  assert.equal(calls[1].options.body, undefined);
});

for (const [code, message] of [
  [409, "Already registered"], [401, "Please log in to register."],
  [404, "Event not found."], [500, "Unable to register. Please try again."],
]) {
  test(`registration handles ${code}`, async () => {
    const page = browser(async () => ({ status: code }));
    await page.register();
    assert.equal(page.status(), message);
  });
}

test("bad credentials and server errors are shown", async () => {
  for (const [code, message] of [
    [401, "Invalid email or password."],
    [500, "Unable to log in. Please try again."],
  ]) {
    const page = browser(async () => ({ status: code }));
    await page.login();
    assert.equal(page.status(), message);
  }
});

test("network failures restore controls and allow retry", async () => {
  let failed = true;
  const page = browser(async () => {
    if (failed) throw new Error("offline");
    return { status: 201 };
  });
  await page.register();
  assert.equal(page.status(), "Unable to connect. Please try again.");
  assert.equal(page.elements["register-button"].disabled, false);
  assert.equal(page.elements["login-button"].disabled, false);
  failed = false;
  await page.register();
  assert.equal(page.status(), "Registered");
});

test("pending login prevents overlapping registration", async () => {
  let finish;
  let calls = 0;
  const page = browser(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const login = page.login();
  assert.equal(page.elements["register-button"].disabled, true);
  assert.equal(page.elements["login-button"].disabled, true);
  await page.register();
  assert.equal(calls, 1);
  finish({ status: 200 });
  await login;
  assert.equal(page.elements["register-button"].disabled, false);
});
