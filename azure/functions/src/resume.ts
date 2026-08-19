// ============================================================
//  resume.ts — load the user's resume/CV from Supabase Storage.
//
//  Storage convention (from the original app):
//    bucket: "resume"  (private)
//    file name: "<userId>-resume.<ext>"   e.g. 0cf8aca0-...-resume.docx
//
//  The user's UUID is the PREFIX of the filename, so we list files
//  starting with userId and download the first match. Supports
//  .pdf (pdf-parse), .docx (mammoth), .txt.
// ============================================================

import { getSupabaseClient } from "./supabase";

/** Extract plain text from a resume buffer based on file extension. */
async function extractText(buf: Buffer, filename: string): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "pdf") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PDFParse } = require("pdf-parse") as typeof import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      const text = result.text?.trim() ?? "";
      return text ? text.slice(0, 6000) : "";
    } catch (err) {
      console.warn(`[resume] pdf-parse failed: ${err}`);
      // Fallback: minimal regex-based extraction
      const text = buf
        .toString("latin1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\(([^)]*)\)/g, "$1")
        .replace(/stream[\s\S]*?endstream/g, " ")
        .replace(/[^a-zA-Z0-9\s@.,:;()\/\-+%$£€'"\n]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, 5000);
    }
  }

  if (ext === "docx") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mammoth = require("mammoth") as typeof import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = result.value?.trim() ?? "";
      if (text) return text.slice(0, 6000);
    } catch (err) {
      console.warn(`[resume] mammoth failed: ${err}`);
    }
    return buf.toString("utf-8").slice(0, 5000);
  }

  // .txt / other
  return buf.toString("utf-8").slice(0, 5000);
}

/**
 * Load the user's resume text from the Supabase `resume` bucket.
 * Returns null when no resume found (caller decides fallback).
 */
export async function loadResumeTextForUser(
  userId: string,
): Promise<string | null> {
  if (!userId) return null;
  const supabase = getSupabaseClient();

  try {
    const { data: files, error: listErr } = await supabase.storage
      .from("resume")
      .list("", { search: userId });

    if (listErr) {
      console.warn(`[resume] list failed: ${listErr.message}`);
      return null;
    }

    // Filename starts with the userId prefix
    const file = files?.find((f) => f.name.startsWith(userId));
    if (!file) {
      console.warn(`[resume] no resume file starting with ${userId}`);
      return null;
    }

    const { data, error: dlErr } = await supabase.storage
      .from("resume")
      .download(file.name);
    if (dlErr) {
      console.warn(`[resume] download failed: ${dlErr.message}`);
      return null;
    }

    const buf = Buffer.from(await (data as Blob).arrayBuffer());
    const text = await extractText(buf, file.name);
    if (!text.trim()) {
      console.warn(`[resume] extracted empty text from ${file.name}`);
      return null;
    }
    console.info(`[resume] loaded resume ${file.name} (${text.length} chars)`);
    return text;
  } catch (err) {
    console.warn(`[resume] load error: ${err}`);
    return null;
  }
}
