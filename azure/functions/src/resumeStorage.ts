// ============================================================
//  resumeStorage.ts — upload generated resumes to Supabase
//  Storage, and update the generated_resumes tracking row.
//
//  Bucket convention:
//    source:      "resume"           (user's uploaded resume)
//    generated:   "generated-resumes" (tailored resumes)
//
//  File name links user + job:
//    "<userId>-<jobId>.html"
//
//  The generated_resumes row (user_id + job_id → resume_url)
//  lets the frontend accurately retrieve the resume for a job.
// ============================================================

import { getSupabaseClient } from "./supabase";

const GENERATED_BUCKET =
  process.env.GENERATED_RESUME_BUCKET ?? "generated-resumes";

/**
 * Render the tailored resume text (from DeepSeek) into a
 * self-contained, print-ready HTML document with a clean,
 * professional, ATS-friendly single-column design.
 *
 * Handles a light markdown subset from DeepSeek:
 *   #  → resume header (name / contact line)
 *   ## → section header (PROFESSIONAL SUMMARY, SKILLS, ...)
 *   ###→ sub-header (role + company)
 *   -  → bullet
 *   **bold** *italic* `code` inline
 */
export function renderResumeHtml(
  resumeText: string,
  meta: { title: string; company: string; userName?: string },
): string {
  const body = renderMarkdown(resumeText, meta);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resume — ${inlineHtml(meta.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      font-family: 'Segoe UI', -apple-system, 'Helvetica Neue', Arial, sans-serif;
      color: #1f2933;
      background: #fff;
      max-width: 794px;   /* A4 @96dpi */
      margin: 0 auto;
      padding: 28px 36px;
      line-height: 1.35;
      font-size: 12.5px;
    }

    /* ── Header ─────────────────────────────────────────── */
    .resume-header {
      border-bottom: 3px solid #0f766e;
      padding-bottom: 8px;
      margin-bottom: 14px;
    }
    .resume-header .name { font-size: 23px; font-weight: 700; color: #0f172a; letter-spacing: 0.02em; }
    .resume-header .target { font-size: 13px; color: #0f766e; font-weight: 600; margin-top: 2px; }
    .resume-header .contact {
      font-size: 11.5px; color: #52606d; margin-top: 5px;
      display: flex; flex-wrap: wrap; gap: 3px 14px;
    }
    .contact span { white-space: nowrap; }

    /* ── Sections ───────────────────────────────────────── */
    section { margin: 0 0 11px; break-inside: avoid; }
    h2.section-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #0f766e;
      border-bottom: 1.5px solid #99f6e4;
      padding-bottom: 2px;
      margin: 0 0 6px;
      break-after: avoid;
    }
    h3.sub {
      font-size: 13px; font-weight: 600; color: #0f172a;
      margin: 7px 0 1px; break-after: avoid;
    }
    .role-meta { font-size: 11.5px; color: #52606d; margin-bottom: 3px; }

    /* ── Body ───────────────────────────────────────────── */
    p { margin: 0 0 4px; }
    ul { margin: 0 0 4px; padding-left: 16px; }
    li { margin: 1px 0; }
    strong { color: #111827; }
    .keep-together { break-inside: avoid; }
    .muted { color: #52606d; }

    /* ── Print: single A4 page, no orphan/split lines ───── */
    @page { size: A4; margin: 12mm 11mm; }
    @media print {
      body { padding: 0; max-width: 100%; font-size: 12px; line-height: 1.3; }
      section { break-inside: avoid; }
      h2.section-title, h3.sub { break-after: avoid; }
      p, li { orphans: 3; widows: 3; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

/** Convert the light-markdown resume text into clean semantic HTML. */
function renderMarkdown(
  text: string,
  meta: { title: string; company: string; userName?: string },
): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  // ── Header block ──────────────────────────────────────────
  // Pass 1: find the candidate's name (the `# ` line). Pass 2:
  // collect contact-like lines (email / phone / location / LinkedIn)
  // that appear before the first "## section" header, regardless of
  // blank lines — DeepSeek sometimes separates them oddly.
  let headerName = "";
  const contactParts: string[] = [];
  let i = 0;

  for (; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i].trim())) {
      headerName = inlineHtml(lines[i].replace(/^#\s+/, "").trim());
      i++;
      break;
    }
  }

  // Collect contact details until the first section header.
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) break; // stop at first real section
    if (/^###\s/.test(line)) break;
    if (/^[-*]\s/.test(line)) break;
    if (!line) continue; // tolerate blank lines
    // Only capture contact-looking lines into the contact row.
    if (
      /@/.test(line) || // email
      /^\+?\d[\d\s\-()]{5,}$/.test(line) || // phone
      /linkedin/i.test(line) || // linkedin
      /^https?:\/\//i.test(line) || // url
      /^(Hong Kong|HK|Remote|Hybrid|[A-Z][a-z]+ [A-Z][a-z]+( [A-Z][a-z]+)*)$/.test(
        line,
      ) // location-ish
    ) {
      contactParts.push(`<span>${inlineHtml(line)}</span>`);
      continue;
    }
    break; // not contact-like — stop collecting
  }

  if (headerName) {
    out.push(
      `<div class="resume-header">` +
        `<div class="name">${headerName}</div>` +
        // Show the TARGET role only (the job being applied for) — NOT the
        // company, since the candidate is an applicant, not an employee.
        `<div class="target">${inlineHtml(meta.title)}</div>` +
        (contactParts.length
          ? `<div class="contact">${contactParts.join("")}</div>`
          : "") +
        `</div>`,
    );
  }

  // ── Remaining content ────────────────────────────────────
  let sectionOpen = false;
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }

    // Section header
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      out.push(`<section><h2 class="section-title">${inlineHtml(h2[1])}</h2>`);
      sectionOpen = true;
      continue;
    }

    // Sub-header (role + company)
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      out.push(`<h3 class="sub">${inlineHtml(h3[1])}</h3>`);
      continue;
    }

    // Bullet list
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inlineHtml(bullet[1])}</li>`);
      continue;
    }

    // Plain paragraph
    closeList();
    out.push(`<p>${inlineHtml(line)}</p>`);
  }

  closeList();
  if (sectionOpen) out.push("</section>");

  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

/**
 * Upload the generated resume HTML (and optional PDF) to the
 * `generated-resumes` bucket. Returns the public URLs + file names.
 */
export async function uploadGeneratedResume(opts: {
  userId: string;
  jobId: string;
  html: string;
  pdf?: Uint8Array;
}): Promise<{
  url: string;
  fileName: string;
  pdfUrl?: string;
  pdfName?: string;
}> {
  const supabase = getSupabaseClient();
  const baseName = `${opts.userId}-${opts.jobId}`;
  const fileName = `${baseName}.html`;

  const { error: upErr } = await supabase.storage
    .from(GENERATED_BUCKET)
    .upload(fileName, opts.html, {
      contentType: "text/html; charset=utf-8",
      upsert: true, // idempotent — regenerate overwrites
    });

  if (upErr) {
    throw new Error(`Failed to upload generated resume: ${upErr.message}`);
  }

  // Public URL so the frontend can open the resume directly.
  const { data } = supabase.storage
    .from(GENERATED_BUCKET)
    .getPublicUrl(fileName);
  const url = data.publicUrl;

  // ── Optional PDF version ─────────────────────────────────
  let pdfUrl: string | undefined;
  let pdfName: string | undefined;
  if (opts.pdf) {
    pdfName = `${baseName}.pdf`;
    const { error: pdfErr } = await supabase.storage
      .from(GENERATED_BUCKET)
      .upload(pdfName, Buffer.from(opts.pdf), {
        contentType: "application/pdf",
        upsert: true,
      });
    if (!pdfErr) {
      const { data: pdfData } = supabase.storage
        .from(GENERATED_BUCKET)
        .getPublicUrl(pdfName);
      pdfUrl = pdfData.publicUrl;
    } else {
      console.warn(`[resumeStorage] PDF upload failed: ${pdfErr.message}`);
    }
  }

  return { url, fileName, pdfUrl, pdfName };
}

/**
 * Insert/update the generated_resumes tracking row.
 * status: queued | building | completed | failed
 */
export async function upsertGeneratedResumeRow(opts: {
  userId: string;
  jobId: string;
  status: "queued" | "building" | "completed" | "failed";
  resumeUrl?: string;
  pdfUrl?: string;
  fileName?: string;
  error?: string;
}): Promise<void> {
  const supabase = getSupabaseClient();

  const row: Record<string, unknown> = {
    user_id: opts.userId,
    job_id: opts.jobId,
    status: opts.status,
  };
  if (opts.resumeUrl) row.resume_url = opts.resumeUrl;
  if (opts.pdfUrl) row.pdf_url = opts.pdfUrl;
  if (opts.fileName) row.file_name = opts.fileName;
  if (opts.error) row.error = opts.error;
  if (opts.status === "building") row.started_at = new Date().toISOString();
  if (opts.status === "completed" || opts.status === "failed") {
    row.completed_at = new Date().toISOString();
  }

  const { error } = await supabase.from("generated_resumes").upsert(row, {
    onConflict: "user_id,job_id",
  });
  if (error) {
    throw new Error(`Failed to upsert generated_resumes row: ${error.message}`);
  }
}
