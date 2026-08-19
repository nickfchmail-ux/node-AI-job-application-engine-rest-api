// Test htmlToText on the saved CTgoodjobs detail HTML
import * as fs from "fs";
import { enrichOneJob } from "../azure/functions/src/enrich";

const html = fs.readFileSync("ctg_detail.html", "utf-8");
const enriched = enrichOneJob({
  title: "test",
  company: "test",
  location: "HK",
  url: "https://jobs.ctgoodjobs.hk/job/10207178",
  rawDetailHtml: html,
});
const jd = enriched.jobDetail;
console.log("raw len:", jd.rawDescription.length);
console.log(
  "resp:",
  jd.responsibilities.length,
  "req:",
  jd.requirements.length,
  "skills:",
  jd.skills.length,
  "ben:",
  jd.benefits.length,
);
console.log("resp[0]:", JSON.stringify(jd.responsibilities[0]));
console.log("req[0]:", JSON.stringify(jd.requirements[0]));
console.log("--- first 500 chars of rawDescription ---");
console.log(jd.rawDescription.slice(0, 500));
