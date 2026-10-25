// The helper other server routes use to get the current user is exported from this file.
// Session transport: bearer token. POST /api/login returns {token}; clients send
// `Authorization: Bearer <token>`. Tokens map to user ids in store.sessions.
import { randomBytes } from "node:crypto";
import { store, findUserById } from "../data.js";

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  store.sessions.set(token, userId);
  return token;
}

export function getToken(req) {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

// Returns {id, email} for the authenticated user, or null.
export function getCurrentUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const user = findUserById(store.sessions.get(token));
  return user ? { id: user.id, email: user.email } : null;
}

// Express middleware: sets req.user = {id, email}, or responds 401.
export function requireUser(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}
