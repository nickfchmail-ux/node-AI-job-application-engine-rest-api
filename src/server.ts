import express, { Request, Response } from "express";
import { loadEnvLocal } from "./db";
import authRouter from "./routes/auth";
import jobRouter from "./routes/jobs";

loadEnvLocal();

const app = express();
app.use(express.json());

app.use("/auth", authRouter);
app.use("/", jobRouter);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("POST /auth/register  { email, password }");
  console.log("POST /auth/login     { email, password }  → access_token + refresh_token");
  console.log("POST /auth/refresh   { refresh_token }     → new access_token + refresh_token");
  console.log(
    "POST /scrape         { keyword, pages?, force? }  [Bearer token required] → { jobId }",
  );
  console.log("GET  /jobs/:jobId    [Bearer token required] → status + result");
});
