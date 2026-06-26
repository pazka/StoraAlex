import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

// A4 in PDF points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 28; // ~10 mm
const COLS = 3;
const ROWS = 8; // 24 labels per A4 sheet

/**
 * Render a printable A4 PDF: a grid of QR codes, each with its human-readable
 * code underneath. Owner prints these and sticks them on objects/places.
 */
export async function generateLabelPdf(codes: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const cellW = (PAGE_W - MARGIN * 2) / COLS;
  const cellH = (PAGE_H - MARGIN * 2) / ROWS;
  const qrSize = Math.min(cellW, cellH) - 26;
  const perPage = COLS * ROWS;

  let page = doc.addPage([PAGE_W, PAGE_H]);

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    const cell = i % perPage;
    if (i > 0 && cell === 0) page = doc.addPage([PAGE_W, PAGE_H]);

    const col = cell % COLS;
    const row = Math.floor(cell / COLS);
    const x0 = MARGIN + col * cellW;
    const yTop = PAGE_H - MARGIN - row * cellH;

    const png = await QRCode.toBuffer(code, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    const img = await doc.embedPng(png);

    const qx = x0 + (cellW - qrSize) / 2;
    const qy = yTop - qrSize - 6;
    page.drawImage(img, { x: qx, y: qy, width: qrSize, height: qrSize });

    const size = 10;
    const tw = font.widthOfTextAtSize(code, size);
    page.drawText(code, { x: x0 + (cellW - tw) / 2, y: qy - 14, size, font, color: rgb(0, 0, 0) });
  }

  return doc.save();
}
