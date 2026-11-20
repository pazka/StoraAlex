// Visual regression harness for StorAlex (hosh-management AGENTS.md §3; pattern of pazka/lbgca, pazka/DrawTogether
// and pazka/MyMurderParty visual/shoot.mjs): the built image on a fresh volume, fixed data made through the API, a
// screenshot (full page) of every use case of visual/cases.mjs at 1400, 1024 and 390 px, each compared with its
// baseline in visual/baseline/, a diff picture for every difference. Node built-ins + the runner's Chrome.
//
//   node visual/shoot.mjs <app url> [--update]
//     app url: http://localhost:<port> of the container (FRESH volume: the first cases need no account at all)
//     CDP_DESKTOP / CDP_PHONE=<port>: the two Chromes started by visual/run.sh (mouse / touch)
//     OUT=visual/out (shots + diffs + report.json)   BASELINE=visual/baseline/
//     --update: copy the new shots over the baselines (QA only, in a PR that says the change is wanted).
//     VISUAL_PRINT_NEW=1: also print every failing shot in the log (visual/from-log.mjs takes them back).
//     ONLY=SC (cases whose id starts with SC; the setup and the seed still run between the phases).
//
// The baseline is only meaningful for the Chrome that made it: report.json records the Chrome version, and a
// version change is reported as such.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { apiCall, connect } from "./cdp.mjs";
import { CASES, FREEZE_JS, NORMALISE_JS, PHASES, WIDTHS, resetFoldingTable, seed, setup } from "./cases.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] || "http://localhost:18138").replace(/\/$/, "");
const update = process.argv.includes("--update");
const OUT = process.env.OUT || "visual/out";
const BASE_DIR = process.env.BASELINE || new URL("./baseline/", import.meta.url).pathname;
// per-pixel tolerance (max channel difference, anti-aliasing) and share of differing pixels allowed
const CHANNEL_TOL = Number(process.env.VISUAL_CHANNEL_TOL || 24);
const MAX_RATIO = Number(process.env.VISUAL_MAX_RATIO || 0.001);
const MAX_HEIGHT = 8000; // a page longer than this is cut (and the size check reports a change)

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true, force: true });
mkdirSync(join(OUT, "diff"), { recursive: true });

const FREEZE_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
  html { scroll-behavior: auto !important; }`;

// ---------- deterministic pictures for the seed (PNG made with zlib) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PICTURES = [
  // photo 1 (the camera tripod): a dark tripod-like shape on a sky gradient
  { name: "tripod.png", data: png(240, 240, (x, y) => {
    const dx = x - 120, dy = y - 120;
    const leg = (Math.abs(dx) < 4 && y > 50) || (dy > 0 && (Math.abs(dx - dy * 0.5) < 4 || Math.abs(dx + dy * 0.5) < 4)) || (Math.abs(dx) < 30 && y > 44 && y < 58);
    return leg ? [40, 40, 48] : [120 + (y >> 2), 170 + (y >> 3), 230];
  }) },
  // photo 2 (Unit 12): an orange door with a dark frame
  { name: "unit.png", data: png(240, 240, (x, y) => (x > 50 && x < 190 && y > 30 && y < 230 ? (x > 60 && x < 180 && y > 40 ? [230, 140, 50] : [60, 60, 60]) : [200, 205, 210])) },
];

// ---------- browsers ----------
const desktop = await connect(Number(process.env.CDP_DESKTOP || 9381));
const phone = await connect(Number(process.env.CDP_PHONE || 9382));
const report = { chrome: desktop.version, app, shots: [], failures: [] };
console.log(`Chrome: ${desktop.version}`);

let cookie = ""; // alex's session "__Host-storalex_sid=<signed token>", from the setup call
const ctx = { resetFoldingTable: () => resetFoldingTable(apiCall, app, cookie) };
let shotNo = 0;

async function shoot(c, width) {
  const mobile = width < 600;
  if (c.before) await c.before(ctx);
  // Each shot comes from its own client address (X-Forwarded-For, trusted from the docker network as on the box:
  // .env.example TRUST_PROXY): the app's per-IP rate limits (300/min, login 10/15 min) stay as they are and a run
  // of ~130 page loads never trips them.
  shotNo++;
  const headers = { "X-Forwarded-For": `10.77.${shotNo >> 8}.${shotNo & 255}` };
  const p = await (mobile ? phone : desktop).page({ init: FREEZE_JS, headers, apiDown: !!c.apiDown });
  try {
    const height = mobile ? 844 : 900;
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await p.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }],
    });
    await p.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Paris" });
    await p.send("Emulation.setLocaleOverride", { locale: "en-US" });
    if (c.as) {
      const [name, value] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
      const ok = await p.send("Network.setCookie", { name, value, url: `${app}/`, secure: true, httpOnly: true, sameSite: "Strict" });
      if (!ok.success) throw new Error("the browser refused the session cookie");
    }
    await p.goto(app + c.path);
    await p.idle();
    if (c.steps) await c.steps(p, ctx);
    if (c.ready && !(await p.waitFor(c.ready))) {
      const text = await p.evaluate("document.body.innerText.slice(0, 300)").catch(() => "?");
      throw new Error(`not ready: ${c.ready}\n    page text: ${JSON.stringify(text)}\n    requests: ${p.requests.join(", ")}`);
    }
    await p.idle();
    await sleep(c.settle ?? 300);
    await p.evaluate(`(() => {
      const s = document.createElement("style"); s.textContent = ${JSON.stringify(FREEZE_CSS)}; document.head.appendChild(s);
      if (!${JSON.stringify(!!c.keepFocus)} && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      if (!${JSON.stringify(!!c.viewport)}) window.scrollTo(0, 0);
      return true;
    })()`);
    await p.evaluate(NORMALISE_JS);
    for (let i = 0; i < 3; i++) await p.evaluate("new Promise((r) => requestAnimationFrame(() => r(true)))");
    await sleep(100);
    // full page, except the cases with a modal (c.viewport): its backdrop and position are relative to the
    // viewport, so the shot is what the visitor sees on the screen
    // A long page: the viewport grows to the page height first, so the fixed bottom bar (.bottomnav, .bulkbar) is
    // drawn at the bottom of the picture as on a tall screen, not in the middle where the first screen ended.
    if (!c.viewport) {
      const m = await p.send("Page.getLayoutMetrics");
      const h = Math.min(MAX_HEIGHT, Math.ceil(m.cssContentSize.height));
      if (h > height) {
        await p.send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile });
        for (let i = 0; i < 3; i++) await p.evaluate("new Promise((r) => requestAnimationFrame(() => r(true)))");
        await sleep(100);
      }
    }
    const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    const errors = [...p.errors].filter((e) => !(c.allowErrors && c.allowErrors.test(e)));
    return { png: Buffer.from(data, "base64"), errors, allowed: p.errors.length - errors.length, requests: [...p.requests] };
  } finally {
    await p.close();
  }
}

/** Compares two PNGs in Chrome (canvas): differing pixels, and a diff picture (red where they differ). */
async function compare(a, b) {
  const p = await desktop.page();
  const r = await p.evaluate(`(async () => {
    const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + b64; });
    const [x, y] = await Promise.all([load(${JSON.stringify(a.toString("base64"))}), load(${JSON.stringify(b.toString("base64"))})]);
    if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] };
    const w = x.width, h = x.height;
    const get = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const da = get(x), db = get(y);
    const out = new OffscreenCanvas(w, h); const g = out.getContext("2d"); const od = g.createImageData(w, h);
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > ${CHANNEL_TOL}) { diff++; od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 0; od.data[i + 3] = 255; }
      else { const v = (da[i] + da[i + 1] + da[i + 2]) / 3; od.data[i] = od.data[i + 1] = od.data[i + 2] = 255 - (255 - v) * 0.25; od.data[i + 3] = 255; }
    }
    g.putImageData(od, 0, 0);
    const blob = await out.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { diff, total: w * h, png: btoa(s) };
  })()`);
  await p.close();
  return r;
}

function printShot(name, data) {
  const b64 = data.toString("base64");
  const n = Math.ceil(b64.length / 8000);
  const sum = createHash("sha256").update(data).digest("hex");
  for (let i = 0; i < n; i++) console.log(`VISUAL-PNG ${name} ${i + 1}/${n} ${sum} ${b64.slice(i * 8000, (i + 1) * 8000)}`);
}

const selected = CASES.filter((x) => !process.env.ONLY || x.id.startsWith(process.env.ONLY));
for (const phase of PHASES) {
  if (phase === "empty") {
    cookie = await setup(apiCall, app);
    console.log("setup: first account alex");
  }
  if (phase === "seeded") {
    await seed(apiCall, app, cookie, PICTURES);
    console.log("seeded: 1 more user, 3 tags, 2 photos, 5 places (1 archived), 6 objects (1 archived), 2 blank labels");
  }
  for (const c of selected.filter((x) => (x.phase || "seeded") === phase)) {
    for (const width of c.widths || WIDTHS) {
      const name = `${c.id}-${width}.png`;
      let shot;
      try {
        shot = await shoot(c, width);
      } catch (e) {
        report.failures.push({ name, reason: `could not take the shot: ${e.message}` });
        console.log(`FAIL  ${name}  (${e.message})`);
        continue;
      }
      writeFileSync(join(OUT, name), shot.png);
      const entry = { name, errors: shot.errors, allowedErrors: shot.allowed, requests: shot.requests };
      if (shot.errors.length) report.failures.push({ name, reason: `page error: ${shot.errors[0]}` });
      if (c.allowErrors && !shot.allowed) report.failures.push({ name, reason: `the pinned page error ${c.allowErrors} did not happen (fixed? update cases.mjs + TESTING.md)` });
      const basePath = join(BASE_DIR, name);
      if (update) {
        copyFileSync(join(OUT, name), basePath);
        entry.result = "baseline updated";
      } else if (!existsSync(basePath)) {
        entry.result = "no baseline";
        report.failures.push({ name, reason: "no baseline (visual/baseline/" + name + ")" });
      } else {
        const r = await compare(readFileSync(basePath), shot.png);
        if (r.size) {
          entry.result = `size ${r.size[0]}x${r.size[1]} -> ${r.size[2]}x${r.size[3]}`;
          report.failures.push({ name, reason: `page size changed: ${entry.result}` });
        } else {
          entry.ratio = r.diff / r.total;
          entry.result = r.diff ? `${r.diff} px differ (${(entry.ratio * 100).toFixed(3)} %)` : "identical";
          if (r.diff) writeFileSync(join(OUT, "diff", name), Buffer.from(r.png, "base64"));
          if (entry.ratio > MAX_RATIO) report.failures.push({ name, reason: entry.result });
        }
      }
      report.shots.push(entry);
      if (process.env.VISUAL_PRINT_NEW && report.failures.some((f) => f.name === name)) printShot(name, shot.png);
      console.log(`${report.failures.some((f) => f.name === name) ? "FAIL" : "ok  "}  ${name}  ${entry.result}`);
    }
  }
}

if (!update) {
  if (!process.env.ONLY) {
    const shot = new Set(report.shots.map((s) => s.name));
    for (const f of (existsSync(BASE_DIR) ? readdirSync(BASE_DIR) : []).filter((f) => f.endsWith(".png"))) {
      if (!shot.has(f) && !report.failures.some((x) => x.name === f)) report.failures.push({ name: f, reason: "baseline without a use case (removed from cases.mjs?)" });
    }
  }
  const prev = existsSync(join(BASE_DIR, "chrome.txt")) ? readFileSync(join(BASE_DIR, "chrome.txt"), "utf8").trim() : "";
  if (prev && prev !== desktop.version) {
    console.log(`note: baselines were made with ${prev}, this run uses ${desktop.version}`);
    report.baselineChrome = prev;
  }
} else {
  writeFileSync(join(BASE_DIR, "chrome.txt"), desktop.version + "\n");
}

desktop.close();
phone.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.shots.length} shots, ${report.failures.length} failure(s)`);
for (const f of report.failures) console.log(`  - ${f.name}: ${f.reason}`);
// exit only once stdout is flushed: on a pipe (CI) process.exit() drops what is still queued (VISUAL-PNG lines,
// see pazka/lbgca#19)
const code = report.failures.length ? 1 : 0;
process.stdout.write("", () => process.exit(code));
