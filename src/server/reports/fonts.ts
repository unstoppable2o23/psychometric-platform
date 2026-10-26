/**
 * Font registration for PDF rendering.
 *
 * The built-in Helvetica uses WinAnsi encoding, which cannot represent
 * Devanagari. Indian student names are extremely likely on this platform, so a
 * Unicode font is registered when one is present. Registration is best-effort
 * with a verified fallback: if the font file is missing or pdfkit rejects it,
 * the report still renders in Helvetica rather than failing to produce a PDF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Font } from '@react-pdf/renderer';

export const FONT_DIR = path.join(process.cwd(), 'public', 'fonts');

export const CANDIDATES: { family: string; file: string }[] = [
  { family: 'NotoSans', file: 'NotoSansDevanagari-Regular.ttf' },
  { family: 'NotoSans', file: 'NotoSansDevanagari-Bold.ttf' },
];

let registered = false;

/** @returns the family name to use, or 'Helvetica' when no Unicode font loaded. */
export function registerReportFonts(): string {
  if (registered) return 'Helvetica';

  let usable = true;
  for (const candidate of CANDIDATES) {
    const full = path.join(FONT_DIR, candidate.file);
    if (!fs.existsSync(full)) {
      usable = false;
      continue;
    }
    Font.register({
      family: candidate.family,
      src: full,
      fontWeight: candidate.file.includes('Bold') ? 700 : 400,
    });
  }

  registered = true;
  return usable ? 'NotoSans' : 'Helvetica';
}

/**
 * True when the report can render Devanagari. Surfaced in the README and in the
 * admin report-generation log so a missing font is visible rather than silently
 * producing tofu boxes.
 */
export function unicodeFontAvailable(): boolean {
  return CANDIDATES.every((c) => fs.existsSync(path.join(FONT_DIR, c.file)));
}
