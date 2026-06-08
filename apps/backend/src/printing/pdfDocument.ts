const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const LEFT = 48;
const TOP = 800;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;

export function createTextPdf(lines: string[]): Buffer {
  const visibleLines = lines.flatMap(wrapLine).slice(0, 52);
  const stream = [
    'BT',
    `/F1 ${FONT_SIZE} Tf`,
    `${LEFT} ${TOP} Td`,
    `${LINE_HEIGHT} TL`,
    ...visibleLines.map((line, index) => `${index === 0 ? '' : 'T* '}${pdfText(line)} Tj`),
    'ET',
  ]
    .filter(Boolean)
    .join('\n');

  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function wrapLine(line: string): string[] {
  const clean = sanitize(line);
  if (clean.length <= 82) return [clean];
  const parts: string[] = [];
  let current = clean;
  while (current.length > 82) {
    parts.push(current.slice(0, 82));
    current = `  ${current.slice(82)}`;
  }
  parts.push(current);
  return parts;
}

function sanitize(value: string): string {
  return value
    .replace(/₹/g, 'Rs ')
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code <= 126 ? ch : ' ';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trimEnd();
}

function pdfText(value: string): string {
  return `(${sanitize(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}
