import axios from "axios";
import { loadEnvLocal } from "./db";

loadEnvLocal();

const BASE = "http://localhost:3000";
const EMAIL = "nickch@gmail.com";
const PASSWORD = "987654321";

async function main() {
  console.log("Logging in...");
  const loginRes = await axios.post(
    `${BASE}/auth/login`,
    { email: EMAIL, password: PASSWORD },
    { headers: { "Content-Type": "application/json" } },
  );
  const token = loginRes.data.access_token;
  if (!token) throw new Error("Login failed: no token returned");

  console.log("Enqueueing scrape job...");
  const enqueueRes = await axios.post(
    `${BASE}/scrape`,
    {
      keyword: "frontend",
      pages: 1,
      boards: ["jobsdb"],
      force: true,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );

  const jobId = enqueueRes.data.jobId;
  console.log(`Enqueued job id=${jobId}`);

  console.log("Polling job status (up to 120s)...");
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const statusRes = await axios.get(`${BASE}/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = statusRes.data;
      console.log(`status=${body.status}`);
      if (body.logs && body.logs.length) {
        console.log("--- logs ---");
        body.logs.forEach((l: string) => console.log(l));
      }
      if (body.status === "done") {
        console.log(
          "Job completed. Result summary:",
          Array.isArray(body.result)
            ? `jobs=${body.result.length}`
            : JSON.stringify(body.result).slice(0, 200),
        );
        return;
      }
      if (body.status === "error") {
        console.error("Job failed:", body.error);
        return;
      }
    } catch (e) {
      console.error("Polling error:", (e as Error).message);
    }
  }
  console.warn("Timed out waiting for job to complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
