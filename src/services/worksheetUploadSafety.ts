import sharp from 'sharp';
import { getPdfPageCount } from './pdf.ts';

export class WorksheetUploadError extends Error {
  constructor(message: string, readonly status = 413) { super(message); }
}

function limit(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export function worksheetMemoryLimits() {
  return {
    pages: limit('WORKSHEET_TOTAL_PAGES', 40, 100),
    imagePixels: limit('WORKSHEET_IMAGE_PIXELS', 12_000_000, 40_000_000),
    dimension: limit('WORKSHEET_IMAGE_DIMENSION', 10_000, 20_000),
    decodedBytes: limit('WORKSHEET_DECODED_BYTES', 960_000_000, 1_600_000_000)
  };
}

export function imageMagicMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'image/gif';
  return null;
}

/** Preflight every file before the first AI call or raster allocation. */
export async function validateWorksheetUploads(files: Array<{ buffer: Buffer; mimetype: string }>): Promise<void> {
  const limits = worksheetMemoryLimits();
  let pages = 0;
  let decodedBytes = 0;
  for (const file of files) {
    if (file.mimetype === 'application/pdf') {
      if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new WorksheetUploadError('Invalid PDF signature.', 415);
      const count = await getPdfPageCount(file.buffer);
      if (!count) throw new WorksheetUploadError('PDF is unreadable or encrypted.', 400);
      pages += count;
      decodedBytes += count * 6_000_000 * 4;
    } else {
      const mime = imageMagicMime(file.buffer);
      if (!mime || mime !== file.mimetype) throw new WorksheetUploadError('Unsupported image or mismatched file signature. Use PNG, JPEG, WebP, or GIF.', 415);
      const meta = await sharp(file.buffer, { limitInputPixels: limits.imagePixels }).metadata()
        .catch(() => { throw new WorksheetUploadError('Image exceeds the pixel limit or is unreadable.'); });
      const width = meta.width || 0;
      const height = meta.height || 0;
      if (!width || !height || width > limits.dimension || height > limits.dimension
        || width * height > limits.imagePixels || (meta.pages || 1) > 1) {
        throw new WorksheetUploadError('Image dimensions exceed the limit; animated/multipage images are unsupported.');
      }
      pages++;
      decodedBytes += width * height * 4;
    }
    if (pages > limits.pages) throw new WorksheetUploadError(`Worksheet job exceeds the total ${limits.pages}-page limit.`);
    if (decodedBytes > limits.decodedBytes) throw new WorksheetUploadError('Worksheet job exceeds the aggregate decoded-memory budget. Split the upload.');
  }
}
