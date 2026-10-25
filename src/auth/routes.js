// Login and the current user. Mounted by src/server.js; keep the default export a router.
import { Router } from "express";
import { findUserByEmail } from "../data.js";
import { createSession, requireUser } from "./index.js";

const router = Router();

router.post("/api/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const user =
    typeof email === "string" && typeof password === "string"
      ? findUserByEmail(email)
      : null;
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.status(200).json({ token: createSession(user.id) });
});

router.get("/api/me", requireUser, (req, res) => {
  res.status(200).json({ id: req.user.id, email: req.user.email });
});

export default router;
