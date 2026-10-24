// Frozen: nobody edits this file.
//
// Seed data and the in-memory store. Everything resets when the server restarts.

export const users = [
  { id: "u1", email: "alice@example.com", password: "alice-pass" },
  { id: "u2", email: "bob@example.com", password: "bob-pass" },
];

export const events = [{ id: "evt-1" }];

// Mutable state. Use it, or keep your own module-level state in your own files.
export const store = {
  sessions: new Map(),
  registrations: [],
};
