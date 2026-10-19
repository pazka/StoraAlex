// QR label sheet (lib/pdf.ts + POST /api/codes/print). Guards pdf-lib and
// qrcode upgrades: valid PDF, A4 pages, 24 labels per page, QR payload still
// decodes to the exact code value.
import { describe, it, expect, afterAll } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { generateLabelPdf } from '../src/server/lib/pdf.ts';
import { makeApp, loginCookie } from './helpers.ts';

const A4 = { width: 595.28, height: 841.89 };
const codes = (n: number) => Array.from({ length: n }, (_, i) => `OBJ-${String(i + 1).padStart(6, '0')}`);

function expectPdfEnvelope(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.subarray(-8).toString('latin1')).toContain('%%EOF');
}

describe('generateLabelPdf', () => {
  it.each([
    [1, 1],
    [24, 1],
    [25, 2],
    [49, 3],
  ])('%i labels -> %i A4 page(s)', async (n, pages) => {
    const bytes = await generateLabelPdf(codes(n));
    expectPdfEnvelope(bytes);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(pages);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(A4.width, 2);
      expect(page.getHeight()).toBeCloseTo(A4.height, 2);
    }
  });

  it('still emits one (blank) page for an empty list', async () => {
    const doc = await PDFDocument.load(await generateLabelPdf([]));
    expect(doc.getPageCount()).toBe(1);
  });

  it('embeds the standard Helvetica font and one QR image per label', async () => {
    const doc = await PDFDocument.load(await generateLabelPdf(codes(3)));
    const objects = doc.context.enumerateIndirectObjects().map(([, o]) => o);
    const dicts = objects.map((o) => (o instanceof PDFDict ? o : o instanceof PDFRawStream ? o.dict : null));
    const fonts = dicts.filter((d) => d?.get(PDFName.of('Type')) === PDFName.of('Font'));
    expect(fonts.map((d) => String(d!.get(PDFName.of('BaseFont'))))).toEqual(['/Helvetica']);
    const images = dicts.filter((d) => d?.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(images).toHaveLength(3);
  });
});

describe('QR payload (same options as lib/pdf.ts)', () => {
  it('decodes back to the exact code value', async () => {
    const value = 'OBJ-000123';
    const png = await QRCode.toBuffer(value, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(320);
    const source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
    const result = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)));
    expect(result.getText()).toBe(value);
  });
});

describe('POST /api/codes/print', () => {
  let close: () => Promise<void>;
  afterAll(() => close?.());

  it('returns an attachment PDF with one page per 24 allocated codes', async () => {
    const { app } = await makeApp();
    close = () => app.close();
    const cookie = await loginCookie(app);
    const res = await app.inject({ method: 'POST', url: '/api/codes/print', payload: { type: 'place', count: 25 }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="storalex-labels-place-25.pdf"');
    expectPdfEnvelope(res.rawPayload);
    expect((await PDFDocument.load(res.rawPayload)).getPageCount()).toBe(2);

    // The allocated codes are sequential and resolvable as unassigned.
    for (const code of ['PLC-000001', 'PLC-000025']) {
      const r = await app.inject({ method: 'GET', url: `/api/resolve/${code}`, headers: { cookie } });
      expect(r.json()).toEqual({ code_value: code, status: 'unassigned', entity_type: 'place', entity_id: null });
    }
    expect((await app.inject({ method: 'GET', url: '/api/resolve/PLC-000026', headers: { cookie } })).statusCode).toBe(404);
  });

  it('enforces count bounds (1..200)', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    for (const count of [0, 201, 1.5]) {
      const res = await app.inject({ method: 'POST', url: '/api/codes/print', payload: { type: 'item', count }, headers: { cookie } });
      expect(res.statusCode, String(count)).toBe(400);
    }
    await app.close();
  });
});
