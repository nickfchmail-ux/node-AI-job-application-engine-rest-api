// ============================================================
//  resumePdf.ts — generate a clean, professional PDF version of
//  the tailored resume using pdf-lib (pure JS, no browser / no
//  native deps — works in the Azure Functions Linux runtime).
//
//  The resume text from DeepSeek is light-markdown (## sections,
//  ### role sub-headers, - bullets). This renders it into a
//  single-page-ish A4 PDF with a clean typographic layout.
// ============================================================

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const TEAL = rgb(0.058, 0.462, 0.431); // #0f766e
const DARK = rgb(0.058, 0.09, 0.2); // #0f172a
const GRAY = rgb(0.32, 0.37, 0.43); // #52606d
const LINE = rgb(0.85, 0.9, 0.92); // #e5e7eb

/**
 * Convert the markdown resume text into a PDF byte buffer (Uint8Array).
 * meta is used for the header role line.
 */
export async function renderResumePdf(
  resumeText: string,
  meta: { title: string; company: string; userName?: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const { width, height } = page.getSize();

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const margin = 48;
  let y = height - margin;

  // ── Header: name / role / contact ──
  const lines = resumeText.split(/\r?\n/);
  let headerName = meta.userName ?? "";
  const contactParts: string[] = [];

  // Parse header: first # line = name, following lines = contact
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (/^#\s+/.test(line)) {
      headerName = line.replace(/^#\s+/, "").trim();
      i++;
      while (i < lines.length) {
        const nxt = lines[i].trim();
        if (!nxt || /^#{1,3}\s/.test(nxt) || /^[-*]\s/.test(nxt)) break;
        contactParts.push(nxt);
        i++;
      }
      break;
    }
    i++;
  }

  // Name
  page.drawText(headerName || "Candidate", {
    x: margin,
    y,
    size: 22,
    font: fontBold,
    color: DARK,
  });
  y -= 20;

  // Target role
  page.drawText(meta.title, {
    x: margin,
    y,
    size: 12,
    font: fontBold,
    color: TEAL,
  });
  y -= 14;

  // Contact line
  if (contactParts.length) {
    page.drawText(contactParts.join("   |   "), {
      x: margin,
      y,
      size: 10,
      font,
      color: GRAY,
    });
    y -= 14;
  }

  // Divider
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 2,
    color: TEAL,
  });
  y -= 18;

  // ── Body ──
  const maxWidth = width - margin * 2;

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Section header (## )
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      y = ensureSpace(y, 36);
      page.drawText(h2[1].toUpperCase(), {
        x: margin,
        y,
        size: 11,
        font: fontBold,
        color: TEAL,
      });
      y -= 8;
      page.drawLine({
        start: { x: margin, y },
        end: { x: margin + 160, y },
        thickness: 0.8,
        color: TEAL,
      });
      y -= 14;
      continue;
    }

    // Sub-header (### role)
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      y = ensureSpace(y, 24);
      page.drawText(h3[1], {
        x: margin,
        y,
        size: 11,
        font: fontBold,
        color: DARK,
      });
      y -= 15;
      continue;
    }

    // Bullet
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      const wrapped = wrapText(bullet[1], font, 10, maxWidth - 14);
      for (const wLine of wrapped) {
        y = ensureSpace(y, 14);
        page.drawText("•", { x: margin, y: y + 1, size: 9, font, color: TEAL });
        page.drawText(wLine, {
          x: margin + 12,
          y,
          size: 10,
          font,
          color: DARK,
        });
        y -= 13;
      }
      continue;
    }

    // Paragraph
    const wrapped = wrapText(line, font, 10, maxWidth);
    for (const wLine of wrapped) {
      y = ensureSpace(y, 14);
      page.drawText(wLine, {
        x: margin,
        y,
        size: 10,
        font,
        color: DARK,
      });
      y -= 13;
    }
  }

  function ensureSpace(currentY: number, needed: number): number {
    if (currentY - needed < margin) {
      const newPage = doc.addPage([595.28, 841.89]);
      return newPage.getSize().height - margin;
    }
    return currentY;
  }

  return doc.save();
}

/** Simple greedy word-wrap using the font's width metrics. */
function wrapText(
  text: string,
  font: import("pdf-lib").PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const w = font.widthOfTextAtSize(candidate, size);
    if (w <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
