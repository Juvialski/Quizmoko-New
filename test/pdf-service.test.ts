import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  cropImageBoundingBox,
  extractPdfPages,
  getPdfPageCount,
  pdfPageToImage,
  renderPdfPageRange
} from '../src/services/pdf.ts';

function createMinimalPdf(pageCount = 1): Buffer {
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index);
  const contentIds = Array.from({ length: pageCount }, (_, index) => 3 + pageCount + index);
  const fontId = 3 + pageCount * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageIds.map((_, index) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`
    ),
    ...contentIds.map((_, index) => {
      const stream = `BT /F1 18 Tf 20 100 Td (Quiz ${index + 1}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF.js renders a multi-page range from one open document', async () => {
  const pdf = createMinimalPdf(2);
  assert.equal(await getPdfPageCount(pdf), 2);

  const rendered: Array<{ pageNumber: number; image: Buffer }> = [];
  const pageCount = await renderPdfPageRange(pdf, {}, page => {
    rendered.push({ pageNumber: page.pageNumber, image: page.image });
  });
  assert.equal(pageCount, 2);
  assert.deepEqual(rendered.map(page => page.pageNumber), [1, 2]);
  rendered.forEach(page => {
    assert.deepEqual(page.image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  const secondPageOnly: number[] = [];
  await renderPdfPageRange(pdf, { startPage: 2, endPage: 2 }, page => {
    secondPageOnly.push(page.pageNumber);
  });
  assert.deepEqual(secondPageOnly, [2]);
  await assert.rejects(
    renderPdfPageRange(pdf, { maxPages: 1 }, () => {}),
    /contains 2 pages; the limit is 1/
  );

  const image = await pdfPageToImage(pdf, 0);
  assert.ok(image);
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  assert.equal(await pdfPageToImage(pdf, -1), null);
  await assert.rejects(
    renderPdfPageRange(pdf, { startPage: 3, endPage: 3 }, () => {}),
    /exceeds 2 pages/
  );
  assert.equal(await extractPdfPages(pdf, 0, 1), null);
});

test('bounding-box crops are explicitly encoded as PNG', async () => {
  const jpeg = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 80, g: 120, b: 180 }
    }
  }).jpeg().toBuffer();

  const dataUrl = await cropImageBoundingBox(jpeg, [100, 100, 600, 600]);
  assert.ok(dataUrl?.startsWith('data:image/png;base64,'));
  const encoded = dataUrl.slice('data:image/png;base64,'.length);
  const png = Buffer.from(encoded, 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
