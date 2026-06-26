import ExcelJS from 'exceljs';

// One workbook, three sheets. Codes are the stable keys so a sheet can be edited
// and re-imported. Places reference their parent by parent_code; items reference
// their location by place_code and their tags by comma-separated tag names.
export const PLACE_COLS = ['code', 'name', 'parent_code', 'info', 'archived'];
export const ITEM_COLS = ['code', 'name', 'place_code', 'price', 'notes', 'tags', 'archived'];
export const TAG_COLS = ['name', 'color', 'kind'];

export interface ExportData {
  places: Record<string, unknown>[];
  items: Record<string, unknown>[];
  tags: Record<string, unknown>[];
}

export async function buildWorkbook(data: ExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StorAlex';
  addSheet(wb, 'Places', PLACE_COLS, data.places);
  addSheet(wb, 'Items', ITEM_COLS, data.items);
  addSheet(wb, 'Tags', TAG_COLS, data.tags);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addSheet(wb: ExcelJS.Workbook, name: string, cols: string[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ header: c, key: c, width: 20 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const obj: Record<string, unknown> = {};
    for (const c of cols) obj[c] = r[c] ?? '';
    ws.addRow(obj);
  }
}

export type ImportData = Record<'places' | 'items' | 'tags', Record<string, string>[]>;

export async function readWorkbook(buf: Buffer): Promise<ImportData> {
  const wb = new ExcelJS.Workbook();
  // Cast: Node 24's generic Buffer vs exceljs's Buffer typing differ harmlessly.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return {
    places: readSheet(wb, 'Places', PLACE_COLS),
    items: readSheet(wb, 'Items', ITEM_COLS),
    tags: readSheet(wb, 'Tags', TAG_COLS),
  };
}

function readSheet(wb: ExcelJS.Workbook, name: string, cols: string[]): Record<string, string>[] {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const headerToKey = new Map<number, string>();
  ws.getRow(1).eachCell((cell, colNumber) => {
    const h = cellToString(cell.value).trim().toLowerCase();
    if (cols.includes(h)) headerToKey.set(colNumber, h);
  });
  const out: Record<string, string>[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string> = {};
    let any = false;
    headerToKey.forEach((key, colNumber) => {
      const s = cellToString(row.getCell(colNumber).value).trim();
      obj[key] = s;
      if (s !== '') any = true;
    });
    if (any) out.push(obj);
  });
  return out;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o['text'] === 'string') return o['text'];
    if ('result' in o) return String(o['result'] ?? '');
    if (Array.isArray(o['richText'])) return (o['richText'] as { text: string }[]).map((r) => r.text).join('');
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}
