import { Router, Request, Response } from "express";
import { getAnonSupabaseClient, getSupabaseClient } from "../db";

const router = Router();

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post("/register", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ id: data.user.id, email: data.user.email });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const supabase = getAnonSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      res.status(401).json({ error: error?.message ?? "Login failed" });
      return;
    }
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      token_type: "Bearer",
      expires_in: data.session.expires_in,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post("/refresh", async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };
  if (!refresh_token) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }
  try {
    const supabase = getAnonSupabaseClient();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });
    if (error || !data.session) {
      res.status(401).json({ error: error?.message ?? "Token refresh failed" });
      return;
    }
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      token_type: "Bearer",
      expires_in: data.session.expires_in,
      user: { id: data.user!.id, email: data.user!.email },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
