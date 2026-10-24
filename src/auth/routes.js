// Login and the current user. Mounted by src/server.js; keep the default export a router.
import { Router } from "express";

const router = Router();

router.post("/api/login", (_req, res) => {
  res.status(501).json({ error: "Not implemented" });
});

router.get("/api/me", (_req, res) => {
  res.status(501).json({ error: "Not implemented" });
});

export default router;
