/**
 * Inspects a rendered report: counts pages, flags blank ones, and confirms that
 * expected narrative text actually made it into the PDF.
 *
 * PDF content streams are Flate-compressed, so this inflates each page's stream
 * and looks for text-showing operators. A page with no text operators is blank.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/inspect-pdf.mts <path> [needle]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const file = process.argv[2];
const needle = process.argv[3];

if (!file) {
  process.stderr.write('usage: inspect-pdf.mts <path.pdf> [needle]\n');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const raw = buf.toString('latin1');

// Map object number -> byte offset of its body.
const objects = new Map<number, { start: number; end: number }>();
const re = /(\d+)\s+0\s+obj/g;
let m: RegExpExecArray | null;
while ((m = re.exec(raw)) !== null) {
  const num = Number(m[1]);
  const end = raw.indexOf('endobj', m.index);
  objects.set(num, { start: m.index + m[0].length, end });
}

/** The Pages tree lists kids in page order; fall back to document order. */
function pageObjectNumbers(): number[] {
  const kids: number[] = [];
  const pagesRe = /\/Type\s*\/Pages[\s\S]{0,400}?\/Kids\s*\[([^\]]*)\]/g;
  let pm: RegExpExecArray | null;
  while ((pm = pagesRe.exec(raw)) !== null) {
    const refs = pm[1].match(/(\d+)\s+0\s+R/g) ?? [];
    for (const r of refs) kids.push(Number(r.split(/\s+/)[0]));
  }
  return kids;
}

const pageNumbers = pageObjectNumbers().length
  ? pageObjectNumbers()
  : [...objects.keys()].filter((n) => {
      const o = objects.get(n)!;
      return raw.slice(o.start, o.end).includes('/Type /Page') || raw.slice(o.start, o.end).includes('/Type/Page');
    });

function inflate(stream: string): string {
  try {
    return zlib.inflateSync(Buffer.from(stream, 'latin1')).toString('latin1');
  } catch {
    return stream;
  }
}

let blank = 0;
const textSamples: string[] = [];

for (const [index, num] of pageNumbers.entries()) {
  const obj = objects.get(num);
  if (!obj) continue;
  const body = raw.slice(obj.start, obj.end);

  const contentsMatch = /\/Contents\s+(\d+)\s+0\s+R/.exec(body);
  const streamNums: number[] = contentsMatch
    ? [Number(contentsMatch[1])]
    : [...body.matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]));

  let content = '';
  for (const sn of streamNums) {
    const so = objects.get(sn);
    if (!so) continue;
    const sRaw = raw.slice(so.start, so.end);
    const sIdx = sRaw.indexOf('stream');
    if (sIdx === -1) continue;
    const eIdx = sRaw.indexOf('endstream');
    content += inflate(sRaw.slice(sIdx + 6, eIdx).replace(/^\r?\n/, '').trimEnd());
  }

  const textOps = (content.match(/\bTj\b|\bTJ\b/g) ?? []).length;
  const pathOps = (content.match(/\bre\b|\bf\b/g) ?? []).length;
  const isBlank = textOps === 0 && pathOps === 0;

  if (isBlank) blank += 1;
  textSamples.push(`  page ${index + 1}: ${String(textOps).padStart(4)} text ops, ${String(pathOps).padStart(4)} path ops${isBlank ? '   <-- BLANK' : ''}`);
}

console.log(`file      : ${path.basename(file)}`);
console.log(`size      : ${buf.length} bytes`);
console.log(`pages     : ${pageNumbers.length}`);
console.log(`blank     : ${blank}`);
console.log(textSamples.join('\n'));

if (needle) {
  const needleNorm = needle.replace(/\s+/g, ' ').toLowerCase();
  let allContent = '';
  for (const num of objects.keys()) {
    const o = objects.get(num)!;
    const body = raw.slice(o.start, o.end);
    const sIdx = body.indexOf('stream');
    if (sIdx === -1) continue;
    const eIdx = body.indexOf('endstream');
    if (eIdx === -1) continue;
    allContent += inflate(body.slice(sIdx + 6, eIdx).replace(/^\r?\n/, '').trimEnd());
  }

  // react-pdf embeds subset fonts with a custom encoding, so glyphs are written
  // as codes rather than ASCII. Plain matching only works for a standard-encoded
  // font, so report that honestly instead of claiming the text is missing.
  const hasStandardEncoding = /\/Encoding\s*\/WinAnsiEncoding/.test(raw);
  if (!hasStandardEncoding) {
    console.log(`needle    : not checked (embedded subset font, text not plain-extractable)`);
  } else {
    const present = allContent.toLowerCase().includes(needleNorm);
    console.log(`needle    : ${present ? 'FOUND' : 'NOT FOUND'} -> "${needle}"`);
  }
}

process.exit(blank > 0 ? 1 : 0);
