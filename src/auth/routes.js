// Login and the current user. Mounted by src/server.js; keep the default export a router.
import { Router } from "express";
import { findUserByEmail } from "../data.js";
import { createSession, requireUser } from "./index.js";

const router = Router();

router.post("/api/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }
  const user = findUserByEmail(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.status(200).json({ token: createSession(user.id) });
});

router.get("/api/me", requireUser, (req, res) => {
  res.status(200).json(req.user);
});

export default router;
