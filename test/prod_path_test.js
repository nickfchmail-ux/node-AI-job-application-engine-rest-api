// Test the exact production resume→summarize path for user 31c3b3a1
const { loadResumeTextForUser } = require("./dist/src/resume.js");
const { summarizeResume } = require("./dist/src/deepseek.js");

async function main() {
  const userId = "31c3b3a1-669d-4e21-8ec3-8f13c7e28630";
  console.log("STEP 1: load resume...");
  const text = await loadResumeTextForUser(userId);
  console.log("resume text length:", text ? text.length : "NULL");
  if (!text) {
    console.log("❌ NO RESUME TEXT LOADED");
    return;
  }
  console.log("first 200:", text.slice(0, 200).replace(/\n/g, " "));
  console.log("\nSTEP 2: summarize...");
  const profile = await summarizeResume(text);
  console.log("✅ PROFILE:", JSON.stringify(profile));
}

main().catch((e) => {
  console.error("❌ ERROR:", e.message);
  process.exit(1);
});
