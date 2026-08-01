import sharp from 'sharp';

export function getFilesByField(files: Express.Multer.File[] | undefined, fieldNames: string[]) {
  if (!files || !Array.isArray(files)) return [];
  return files.filter(f => fieldNames.includes(f.fieldname));
}

export function sortQuestionsByIndex(questions: any[]) {
  if (!Array.isArray(questions)) return;
  
  const parseIndex = (idxStr: any): { num: number; suffix: string } => {
    const str = String(idxStr || '').trim();
    const match = str.match(/^(?:(?:question|q)\s*[:#.-]?\s*|#\s*)?(\d+)(.*)$/i);
    if (match) {
      return {
        num: parseInt(match[1], 10),
        suffix: match[2].toLowerCase()
      };
    }
    return { num: Infinity, suffix: str.toLowerCase() };
  };

  questions.sort((a: any, b: any) => {
    const sourceId = (value: any) => value?.source?.original_index
      ?? value?.original_index
      ?? value?.source_id
      ?? value?.id;
    const parseA = parseIndex(sourceId(a));
    const parseB = parseIndex(sourceId(b));
    if (parseA.num !== parseB.num) {
      return parseA.num - parseB.num;
    }
    return parseA.suffix.localeCompare(parseB.suffix);
  });
}

export async function cropImageBoundingBox(fileBuffer: Buffer, bbox: any): Promise<string | null> {
  if (!bbox || !Array.isArray(bbox) || bbox.length < 4) return null;
  try {
    const [ymin, xmin, ymax, xmax] = bbox.map((n: any) => Number(n));
    if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) return null;

    let scale = 1000;
    if (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) scale = 1;
    else if (ymin <= 100 && xmin <= 100 && ymax <= 100 && xmax <= 100) scale = 100;

    let ymin_norm = (ymin / scale) * 1000;
    let xmin_norm = (xmin / scale) * 1000;
    let ymax_norm = (ymax / scale) * 1000;
    let xmax_norm = (xmax / scale) * 1000;

    let y1 = Math.min(ymin_norm, ymax_norm);
    let y2 = Math.max(ymin_norm, ymax_norm);
    let x1 = Math.min(xmin_norm, xmax_norm);
    let x2 = Math.max(xmin_norm, xmax_norm);

    const boxW = x2 - x1;
    const boxH = y2 - y1;

    if (boxW < 20 || boxH < 20 || (boxW > 950 && boxH > 950)) {
      console.log(`[CROP] Bounding box is too small, empty, or covers entire page (${boxW}x${boxH}). Skipping crop.`);
      return null;
    }

    const sharpOptions = { limitInputPixels: 40_000_000 };
    const meta = await sharp(fileBuffer, sharpOptions).metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;

    const padX = Math.min(80, Math.max(30, Math.round(boxW * 0.15 + 35)));
    const padY = Math.min(80, Math.max(30, Math.round(boxH * 0.15 + 35)));

    y1 = Math.max(0, y1 - padY);
    y2 = Math.min(1000, y2 + padY);
    x1 = Math.max(0, x1 - padX);
    x2 = Math.min(1000, x2 + padX);

    let left = Math.floor((x1 / 1000) * width);
    let top = Math.floor((y1 / 1000) * height);
    let cropWidth = Math.floor(((x2 - x1) / 1000) * width);
    let cropHeight = Math.floor(((y2 - y1) / 1000) * height);

    left = Math.max(0, Math.min(width - 10, left));
    top = Math.max(0, Math.min(height - 10, top));
    cropWidth = Math.max(10, Math.min(width - left, cropWidth));
    cropHeight = Math.max(10, Math.min(height - top, cropHeight));

    const croppedBuffer = await sharp(fileBuffer, sharpOptions)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
  } catch (err) {
    console.warn('Error cropping bounding box:', err);
    return null;
  }
}

async function loadPdfDocument(pdfBuffer: Buffer): Promise<any> {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    isEvalSupported: false,
    useSystemFonts: true
  } as any);
  return loadingTask.promise;
}

async function renderLoadedPdfPage(pdfDocument: any, pageNumber: number): Promise<Buffer> {
  let page: any = null;
  try {
    page = await pdfDocument.getPage(pageNumber);
    const baseScale = 200 / 72;
    const initialViewport = page.getViewport({ scale: baseScale });
    if (
      !Number.isFinite(initialViewport.width)
      || !Number.isFinite(initialViewport.height)
      || initialViewport.width <= 0
      || initialViewport.height <= 0
    ) {
      throw new Error(`PDF page ${pageNumber} has invalid dimensions`);
    }

    // Keep a single RGBA canvas near 48 MB so concurrent Render requests do not
    // exhaust a small instance while retaining more than enough OCR detail.
    const maxPixels = 12_000_000;
    const pixelCount = initialViewport.width * initialViewport.height;
    const scale = pixelCount > maxPixels
      ? baseScale * Math.sqrt(maxPixels / pixelCount)
      : baseScale;
    const viewport = page.getViewport({ scale });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const canvasContext = canvas.getContext('2d');

    await page.render({ canvasContext, viewport, canvas }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    if (page) {
      try {
        page.cleanup();
      } catch {
        // Ignore cleanup errors after the rendered page result is known.
      }
    }
  }
}

export interface RenderedPdfPage {
  pageIndex: number;
  pageNumber: number;
  pageCount: number;
  image: Buffer;
}

export interface PdfPageRangeOptions {
  startPage?: number;
  endPage?: number;
  maxPages?: number;
}

/**
 * Opens a PDF once, renders the requested pages sequentially, and releases each
 * PDF.js page before moving to the next one. The callback is awaited so callers
 * can process a page without accumulating every rendered image in memory.
 */
export async function renderPdfPageRange(
  pdfBuffer: Buffer,
  options: PdfPageRangeOptions,
  onPage: (page: RenderedPdfPage) => void | Promise<void>
): Promise<number> {
  const startPage = options.startPage ?? 1;
  const requestedEndPage = options.endPage;
  const maxPages = options.maxPages;
  if (
    !Number.isInteger(startPage)
    || startPage < 1
    || (requestedEndPage !== undefined && (!Number.isInteger(requestedEndPage) || requestedEndPage < startPage))
    || (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1))
  ) {
    throw new Error('Invalid PDF page range');
  }

  let pdfDocument: any = null;
  try {
    pdfDocument = await loadPdfDocument(pdfBuffer);
    const pageCount = Number(pdfDocument.numPages);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error('PDF does not contain any readable pages');
    }
    if (maxPages !== undefined && pageCount > maxPages) {
      throw new Error(`PDF contains ${pageCount} pages; the limit is ${maxPages}`);
    }

    const endPage = requestedEndPage ?? pageCount;
    if (startPage > pageCount || endPage > pageCount) {
      throw new Error(`Requested PDF page range ${startPage}-${endPage} exceeds ${pageCount} pages`);
    }

    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
      const image = await renderLoadedPdfPage(pdfDocument, pageNumber);
      await onPage({
        pageIndex: pageNumber - 1,
        pageNumber,
        pageCount,
        image
      });
    }
    return pageCount;
  } finally {
    if (pdfDocument) {
      try {
        await pdfDocument.destroy();
      } catch {
        // Ignore PDF.js cleanup failures after the request result is known.
      }
    }
  }
}

export async function pdfPageToImage(pdfBuffer: Buffer, pageIndex: number = 0): Promise<Buffer | null> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
  let result: Buffer | null = null;
  try {
    await renderPdfPageRange(
      pdfBuffer,
      { startPage: pageIndex + 1, endPage: pageIndex + 1 },
      page => {
        result = page.image;
      }
    );
    return result;
  } catch (err) {
    console.warn(`Unable to render PDF page ${pageIndex + 1} with PDF.js:`, err);
    return null;
  }
}

export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  let pdfDocument: any = null;
  try {
    pdfDocument = await loadPdfDocument(pdfBuffer);
    const count = Number(pdfDocument.numPages);
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch (err) {
    console.warn('Unable to read PDF page count with PDF.js:', err);
    return 0;
  } finally {
    if (pdfDocument) {
      try {
        await pdfDocument.destroy();
      } catch {
        // Ignore PDF.js cleanup failures after the request result is known.
      }
    }
  }
}

/**
 * Retained for compatibility with older callers. Worksheet extraction now sends
 * rendered PNG pages to Gemini, so a PDF-splitting subprocess is no longer used.
 */
export async function extractPdfPages(pdfBuffer: Buffer, startPage: number, endPage: number): Promise<Buffer | null> {
  if (
    !Number.isInteger(startPage)
    || !Number.isInteger(endPage)
    || startPage < 1
    || endPage < startPage
  ) {
    return null;
  }
  const pageCount = await getPdfPageCount(pdfBuffer);
  if (pageCount === 0 || endPage > pageCount) return null;
  return null;
}
