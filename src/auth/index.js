// The helper other server routes use to get the current user is exported from this file.
// Sessions use a bearer token: POST /api/login returns {token}, and requests send
// `Authorization: Bearer <token>`. Tokens map to user ids in store.sessions.
import { randomBytes } from "node:crypto";
import { store, findUserById } from "../data.js";

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  store.sessions.set(token, userId);
  return token;
}

export function getToken(req) {
  const header = req.get?.("authorization") ?? req.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

// Returns {id, email} for the authenticated user, or null.
export function getCurrentUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const userId = store.sessions.get(token);
  const user = userId ? findUserById(userId) : null;
  return user ? { id: user.id, email: user.email } : null;
}

// Express middleware: sets req.user or responds 401.
export function requireUser(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}
