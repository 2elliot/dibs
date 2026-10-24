// Frozen: nobody edits this file. Seeded test data and the in-memory store, reset on every
// start. These are test accounts, not real credentials.
export const users = [
  { id: "u1", email: "alice@example.com", password: "alice-pass" },
  { id: "u2", email: "bob@example.com", password: "bob-pass" },
];

export const events = [{ id: "evt-1", title: "Cal Hacks demo night" }];

export const store = {
  sessions: new Map(),
  registrations: [],
};

export const findUserByEmail = (email) =>
  users.find((user) => user.email === email) ?? null;
export const findUserById = (id) =>
  users.find((user) => user.id === id) ?? null;
export const findEvent = (id) =>
  events.find((event) => event.id === id) ?? null;
