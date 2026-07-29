import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import sharp from 'sharp';

export function getFilesByField(files: Express.Multer.File[] | undefined, fieldNames: string[]) {
  if (!files || !Array.isArray(files)) return [];
  return files.filter(f => fieldNames.includes(f.fieldname));
}

export function sortQuestionsByIndex(questions: any[]) {
  if (!Array.isArray(questions)) return;
  
  const parseIndex = (idxStr: any): { num: number; suffix: string } => {
    const str = String(idxStr || '').trim();
    const match = str.match(/^(\d+)(.*)$/);
    if (match) {
      return {
        num: parseInt(match[1], 10),
        suffix: match[2].toLowerCase()
      };
    }
    return { num: Infinity, suffix: str.toLowerCase() };
  };

  questions.sort((a: any, b: any) => {
    const parseA = parseIndex(a.original_index);
    const parseB = parseIndex(b.original_index);
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

    const meta = await sharp(fileBuffer).metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;

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

    const croppedBuffer = await sharp(fileBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer();

    return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
  } catch (err) {
    console.warn('Error cropping bounding box:', err);
    return null;
  }
}

export async function pdfPageToImage(pdfBuffer: Buffer, pageIndex: number = 0): Promise<Buffer | null> {
  const tempIn = path.join('/tmp', `input_${crypto.randomBytes(8).toString('hex')}.pdf`);
  const tempOut = path.join('/tmp', `output_${crypto.randomBytes(8).toString('hex')}.png`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    const pageNum = pageIndex + 1;
    execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r200 -dFirstPage=${pageNum} -dLastPage=${pageNum} -sOutputFile="${tempOut}" "${tempIn}"`);
    if (fs.existsSync(tempOut)) {
      return fs.readFileSync(tempOut);
    }
  } catch (err) {
    console.error('Error rendering PDF page to image with Ghostscript:', err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (e) {}
  }
  return null;
}

export function getPdfPageCount(pdfBuffer: Buffer): number {
  const tempIn = path.join('/tmp', `count_${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    const output = execSync(`gs -q -dNODISPLAY -c "(${tempIn}) (r) file runpdfbegin pdfpagecount = quit"`).toString().trim();
    const count = parseInt(output, 10);
    if (!isNaN(count)) return count;
  } catch (err) {
    console.error('Error getting PDF page count with gs:', err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
  }
  return 1;
}

export async function extractPdfPages(pdfBuffer: Buffer, startPage: number, endPage: number): Promise<Buffer | null> {
  const tempIn = path.join('/tmp', `chunk_in_${crypto.randomBytes(8).toString('hex')}.pdf`);
  const tempOut = path.join('/tmp', `chunk_out_${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dFirstPage=${startPage} -dLastPage=${endPage} -sOutputFile="${tempOut}" "${tempIn}"`);
    if (fs.existsSync(tempOut)) {
      return fs.readFileSync(tempOut);
    }
  } catch (err) {
    console.error(`Error splitting PDF pages ${startPage}-${endPage} with Ghostscript:`, err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (e) {}
  }
  return null;
}
