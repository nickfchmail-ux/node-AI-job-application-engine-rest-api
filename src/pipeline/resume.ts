import * as fs from "fs";
import mammoth from "mammoth";
import * as path from "path";
import { getSupabaseClient } from "../db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (
  buf: Buffer,
) => Promise<{ text: string }>;

async function extractTextFromBuffer(
  buf: Buffer,
  filename: string,
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    const result = await pdfParse(buf);
    return result.text;
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  // .txt or anything else — treat as plain text
  return buf.toString("utf-8");
}

/**
 * Load resume text from Supabase storage (server) or the local resume/ folder (CLI).
 */
export async function loadResumeText(
  userId: string | undefined,
  log: (msg: string) => void = console.log,
): Promise<string> {
  // ── Server path: userId provided → Supabase only, no fallback ────────────
  if (userId) {
    const supabase = getSupabaseClient();
    const { data: files, error: listErr } = await supabase.storage
      .from("resume")
      .list("", { search: userId });

    if (listErr)
      throw new Error(`Failed to list resume bucket: ${listErr.message}`);

    const file = files?.find((f) => f.name.startsWith(userId));
    if (!file)
      throw new Error(
        `No resume found for this account. Please upload a resume first.`,
      );

    const { data, error: dlErr } = await supabase.storage
      .from("resume")
      .download(file.name);
    if (dlErr) throw new Error(`Failed to download resume: ${dlErr.message}`);

    const buf = Buffer.from(await (data as Blob).arrayBuffer());
    const text = await extractTextFromBuffer(buf, file.name);
    if (!text.trim())
      throw new Error(
        `Resume file "${file.name}" appears to be empty or unreadable.`,
      );
    log(`Resume loaded: ${file.name} (${text.length} chars)`);
    return text;
  }

  // ── CLI path: no userId → local resume/ folder ────────────────────────────
  const resumeDir = path.join(process.cwd(), "resume");
  const resumeFile = fs
    .readdirSync(resumeDir)
    .find((f) =>
      [".docx", ".pdf", ".txt"].includes(path.extname(f).toLowerCase()),
    );
  if (!resumeFile) throw new Error("No resume file found in resume/ folder.");
  const buf = fs.readFileSync(path.join(resumeDir, resumeFile));
  const text = await extractTextFromBuffer(buf, resumeFile);
  if (!text.trim())
    throw new Error(
      `Resume file "${resumeFile}" appears to be empty or unreadable.`,
    );
  log(`Resume loaded: ${resumeFile} (${text.length} chars)`);
  return text;
}
