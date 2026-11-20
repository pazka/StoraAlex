// Visual use cases covered by the harness (ids from TESTING.md "Visual use cases").
// Each: { id, path, phase?, as?, widths?, before?, steps?, ready, viewport?, settle?, keepFocus?, allowErrors?, apiDown? }.
// - path: opened in a NEW browser context (a fresh visitor) at http://localhost:<port><path>.
// - phase: the cases run phase by phase, each phase on the data the previous steps left:
//     "fresh"    a brand new instance: no user at all (first-run setup screen);
//     "empty"    the first account exists (made through POST /api/auth/setup), nothing else;
//     "seeded"   (default) after seed() made the fixed data below through the API, as the PWA does;
//     "mutating" last: cases whose steps change data (CONFIRM a move); their `before` resets what they change.
//   Within a phase no case changes what another case shows.
// - as: "alex" = the visitor holds alex's session cookie (from the setup call) before the page opens; none = logged out.
// - steps(page, ctx): what the visitor does before the shot. ready: a JS expression that must become true.
// - viewport: the shot is the screen as the steps left it (a modal), not the full page.
// - allowErrors: the page error(s) this case produces today (a pinned bug, TESTING.md) do not fail the shot.
// - apiDown: every /api/ and /media/ request fails (the server is unreachable), the PWA files still load.
//
// Determinism: fresh volume per run, fixed data made in a fixed order, the clock of the page starts at a fixed
// time and Math.random is seeded (FREEZE_JS), no camera (getUserMedia rejects: the scanner shows its manual-entry
// fallback, as on a device without a camera), no service worker (each shot is a first visit), animations,
// transitions and caret off, fixed viewport height (900, phone 844), full-page shots. The server writes its own
// timestamps (SQLite datetime('now'): history, last login) and the image has no fake clock, so every
// "YYYY-MM-DD HH:MM:SS" text on the page is replaced by STAMP just before the shot (NORMALISE_JS).
export const WIDTHS = [1400, 1024, 390];
const js = (v) => JSON.stringify(v);

export const ADMIN = { username: "alex", password: "visual-password-alex" };
export const STAMP = "2026-01-01 12:00:00";

// ---------- seeded data (made through the API, as the PWA does) ----------
export const SEED = {
  users: [{ username: "marie", password: "visual-password-marie" }],
  // ids 1..3 (GET /api/tags lists them by kind, then name)
  tags: [
    { name: "Expo Lyon 2026", kind: "event", color: "#e76f51" },
    { name: "Fragile", kind: "flag", color: "#f4a261" },
    { name: "Loaned", kind: "other", color: "#2a9d8f" },
  ],
  // ids 1..5, codes PLC-000001..PLC-000005
  places: [
    { name: "Unit 12", info: "Self-storage, 2nd floor. Badge in the blue key box.", photo: 2, tags: [1] },
    { name: "Shelf 1", parent: 1 },
    { name: "Shelf 2", parent: 1, info: "Top shelf: light things only." },
    { name: "Garage", tags: [3] },
    { name: "Old cabinet", archive: true },
  ],
  // ids 1..6, codes OBJ-000001..OBJ-000006; each item is finished in its own second (the list is ordered by
  // updated_at, a SQLite text timestamp with 1 s resolution)
  items: [
    { name: "Camera tripod", place: 2, photo: 1, price: 129.99, notes: "Aluminium, with the quick-release plate.", tags: [1, 2] },
    { name: "Canvas 80x60", place: 2, tags: [1] },
    { name: "Projector", place: 1, price: 450 },
    { name: "Folding table", place: null, notes: "Lent to the neighbours." },
    { name: "Desk lamp", place: 4 },
    { name: "Broken chair", place: 4, archive: true },
  ],
  // then 2 blank object labels are printed: OBJ-000007, OBJ-000008 (unassigned)
  blankItemLabels: 2,
};

/** A tiny API client with its own session cookie (Node side, for seeding). */
export function client(apiCall, app, cookie = "") {
  const call = async (method, path, body, { raw = false, type } = {}) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}) };
    let payload = body;
    if (body !== undefined && !type) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    if (type) headers["Content-Type"] = type;
    const r = await apiCall(app, method, path, { headers, body: payload });
    const set = r.headers["set-cookie"];
    if (set) cookie = set.map((c) => c.split(";")[0]).join("; ");
    if (r.status >= 300) throw new Error(`seed: ${method} ${path} -> ${r.status} ${r.body.toString("utf8").slice(0, 200)}`);
    if (raw) return r.body;
    const text = r.body.toString("utf8");
    try { return JSON.parse(text); } catch { return text; }
  };
  return { call, cookie: () => cookie };
}

/** The first account (first-run setup). Returns its session cookie "name=value". */
export async function setup(apiCall, app) {
  const c = client(apiCall, app);
  await c.call("POST", "/api/auth/setup", ADMIN);
  if (!c.cookie().startsWith("__Host-storalex_sid=")) throw new Error(`setup: unexpected cookie ${c.cookie()}`);
  return c.cookie();
}

/** Waits until the wall clock enters a new second (+50 ms), so the next write gets a later SQLite timestamp. */
async function nextSecond() {
  const now = Date.now();
  await new Promise((r) => setTimeout(r, 1000 - (now % 1000) + 50));
}

export async function seed(apiCall, app, cookie, png) {
  const c = client(apiCall, app, cookie);
  for (const u of SEED.users) await c.call("POST", "/api/users", u);
  for (const t of SEED.tags) await c.call("POST", "/api/tags", t);
  for (const p of png) {
    const boundary = "visualboundary0123456789";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${p.name}"\r\nContent-Type: image/png\r\n\r\n`),
      p.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await c.call("POST", "/api/media", body, { type: `multipart/form-data; boundary=${boundary}` });
  }
  for (const [i, p] of SEED.places.entries()) {
    const r = await c.call("POST", "/api/places", {
      name: p.name, info: p.info ?? null, photo_id: p.photo ?? null, parent_place_id: p.parent ?? null, method: "manual",
    });
    if (r.id !== i + 1) throw new Error(`seed: place ${p.name} got id ${r.id}`);
    for (const t of p.tags || []) await c.call("POST", `/api/places/${r.id}/tags`, { tag_id: t });
    if (p.archive) await c.call("POST", `/api/places/${r.id}/archive`);
  }
  for (const [i, it] of SEED.items.entries()) {
    await nextSecond();
    const r = await c.call("POST", "/api/items", {
      name: it.name, notes: it.notes ?? null, photo_id: it.photo ?? null, price: it.price ?? null,
      location_place_id: it.place, method: "manual",
    });
    if (r.id !== i + 1) throw new Error(`seed: item ${it.name} got id ${r.id}`);
    for (const t of it.tags || []) await c.call("POST", `/api/items/${r.id}/tags`, { tag_id: t });
    if (it.archive) await c.call("POST", `/api/items/${r.id}/archive`);
  }
  await nextSecond();
  await c.call("POST", "/api/codes/print", { type: "item", count: SEED.blankItemLabels }, { raw: true });
  // read back what the pages will show
  const items = await c.call("GET", "/api/items");
  const names = items.map((i) => `${i.name} ${i.code_display}`).join(", ");
  const want = "Desk lamp OBJ-000005, Folding table OBJ-000004, Projector OBJ-000003, Canvas 80x60 OBJ-000002, Camera tripod OBJ-000001";
  if (names !== want) throw new Error(`seed: unexpected items list: ${names}`);
  const blank = await c.call("GET", "/api/resolve/OBJ-000007");
  if (blank.status !== "unassigned") throw new Error(`seed: OBJ-000007 is ${js(blank)}`);
}

/** Puts "Folding table" (item 4) back out of storage (before each shot of the CONFIRM case). */
export async function resetFoldingTable(apiCall, app, cookie) {
  const c = client(apiCall, app, cookie);
  const it = await c.call("GET", "/api/items/4");
  if (it.location_place_id != null) await c.call("POST", "/api/items/4/move", { to_place_id: null, method: "manual" });
}

// Runs in every document before its own scripts (Page.addScriptToEvaluateOnNewDocument).
export const FREEZE_JS = `(() => {
  const FIXED = 1767268800000; // 2026-01-01T12:00:00Z, then advancing with the page's own monotonic clock
  let s = 0x9e3779b9;
  Math.random = () => { // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const D = Date;
  const now = () => FIXED + Math.floor(performance.now());
  function FixedDate(...a) { return a.length ? new D(...a) : new D(now()); }
  FixedDate.prototype = D.prototype; FixedDate.now = now; FixedDate.UTC = D.UTC; FixedDate.parse = D.parse;
  window.Date = FixedDate;
  // no service worker: every shot is a first visit, and no update can reload the page mid-shot
  try { delete Navigator.prototype.serviceWorker; } catch {}
  // no camera, as on a device without one: the scanner falls back to manual code entry
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Requested device not found", "NotFoundError"));
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
  }
})();`;

// Run just before the shot: server-made timestamps -> STAMP (see above).
export const NORMALISE_JS = `(() => {
  const re = /\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?/g;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = w.nextNode(); t; t = w.nextNode()) if (re.test(t.nodeValue)) { t.nodeValue = t.nodeValue.replace(re, ${js(STAMP)}); n++; }
  return n;
})()`;

// ---------- steps ----------
async function must(p, expression, what, ms) {
  if (!(await p.waitFor(expression, ms))) throw new Error(`step failed: ${what}`);
}
/** Clicks the first visible element matching sel whose text contains label. */
async function click(p, sel, label = "") {
  await must(p, `(() => {
    const e = [...document.querySelectorAll(${js(sel)})].find((x) => x.textContent.includes(${js(label)}) && !x.disabled && x.offsetParent);
    if (!e) return false;
    e.click();
    return true;
  })()`, `click ${sel} "${label}"`);
}
/** Types into the first element matching sel (focus + Input.insertText = real key input for React). */
async function type(p, sel, text) {
  await must(p, `(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.focus(); return true; })()`, `focus ${sel}`);
  await p.send("Input.insertText", { text });
}
/** Scanner fallback: types a code in the manual-entry box and presses its "Enter" button. */
async function enterCode(p, code) {
  await must(p, manualEntry, "manual code entry");
  await type(p, ".notice form input", code);
  await click(p, ".notice form button", "Enter");
}

const text = (t) => `document.body.innerText.includes(${js(t)})`;
const listItems = (n) => `document.querySelectorAll("main .list-item").length === ${n}`;
const imgsLoaded = `[...document.images].every((i) => i.complete && i.naturalWidth > 0)`;
const manualEntry = `!!document.querySelector(".notice form input") && ${text("No camera available")}`;
const preview = `(document.querySelector(".preview-box")?.innerText || "")`;
const modal = `document.querySelector(".modal")`;
const loginForm = `!!document.querySelector("form.card #u") && ${text("Sign in")}`;

export const CASES = [
  // ---------- phase "fresh": no account yet ----------
  // any URL of a fresh instance lands on the first-run setup form
  { id: "S1-first-run-setup", phase: "fresh", path: "/", ready: `location.pathname === "/login" && ${text("create the first account")} && ${text("Create account")}` },

  // ---------- phase "empty": alex exists, no data ----------
  { id: "E1-items-empty", phase: "empty", as: "alex", path: "/items", ready: text("No objects yet") },
  { id: "E2-places-empty", phase: "empty", as: "alex", path: "/places", ready: text("No places yet") },
  { id: "E3-tags-empty", phase: "empty", as: "alex", path: "/tags", ready: `!!document.querySelector("#tn") && !document.querySelector(".list-item")` },
  { id: "E4-history-empty", phase: "empty", as: "alex", path: "/history", ready: text("No history yet.") },
  { id: "E5-archive-empty", phase: "empty", as: "alex", path: "/archive", ready: text("Nothing archived.") },

  // ---------- logged out ----------
  { id: "L1-login", path: "/login", ready: `${loginForm} && !${text("create the first account")}` },
  {
    // a page that needs a session sends the visitor to /login; a wrong password says so
    id: "L2-login-wrong-password", path: "/items",
    steps: async (p) => {
      await must(p, `location.pathname === "/login" && ${loginForm}`, "login form");
      await type(p, "#u", ADMIN.username);
      await type(p, "#p", "not-the-password");
      await click(p, "form.card button", "Sign in");
    },
    ready: `document.querySelector(".error")?.textContent === "invalid credentials"`,
  },
  {
    // the server is unreachable: /api/me fails, the visitor gets the login form (no message)
    id: "X1-server-unreachable", path: "/", as: "alex", apiDown: true,
    ready: `location.pathname === "/login" && ${loginForm}`,
  },

  // ---------- scan (home) ----------
  { id: "SC1-scan-home", path: "/", as: "alex", ready: `${manualEntry} && ${preview}.includes("Scan an object or a place")` },
  {
    id: "SC2-scan-object-then-place", path: "/", as: "alex",
    steps: async (p) => {
      await enterCode(p, "OBJ-000001");
      await must(p, `${preview}.includes("scan or pick a destination")`, "object added");
      await enterCode(p, "PLC-000004");
    },
    ready: `${preview}.includes("Garage") && ${preview}.includes("Camera tripod") && !document.querySelector(".bigbtn.confirm").disabled`,
  },
  {
    id: "SC3-scan-unknown-code", path: "/", as: "alex",
    steps: async (p) => { await enterCode(p, "OBJ-999999"); },
    ready: `${preview}.includes("Unknown code OBJ-999999")`,
  },
  {
    id: "SC4-scan-take-out", path: "/", as: "alex",
    steps: async (p) => {
      await enterCode(p, "OBJ-000003");
      await must(p, `${preview}.includes("Projector")`, "object added");
      await click(p, "button", "Take out");
    },
    ready: `${preview}.includes("out of storage") && !!document.querySelector("button.btn.primary")`,
  },
  {
    id: "SC5-scan-pick-place", path: "/", as: "alex", viewport: true,
    steps: async (p) => { await must(p, manualEntry, "scan page"); await click(p, "button", "Pick place"); },
    ready: `!!${modal} && ${modal}.innerText.includes("Destination place") && ${modal}.querySelectorAll(".list-item").length === 4`,
  },
  {
    // a blank (printed, unassigned) label opens "New object" with that label
    id: "SC6-scan-blank-label", path: "/", as: "alex",
    steps: async (p) => { await enterCode(p, "OBJ-000007"); },
    ready: `location.pathname === "/items/new" && ${text("Label OBJ-000007 will be attached.")}`,
  },

  // ---------- objects ----------
  { id: "I1-items", path: "/items", as: "alex", ready: `${listItems(5)} && ${imgsLoaded}` },
  { id: "I2-items-search", path: "/items?q=ca", as: "alex", ready: `${listItems(2)} && ${text("Canvas 80x60")} && ${imgsLoaded}` },
  { id: "I3-items-out", path: "/items?status=out", as: "alex", ready: `${listItems(1)} && ${text("Folding table")}` },
  { id: "I4-items-by-tag", path: "/items?tag=1", as: "alex", ready: `${listItems(2)} && ${text("Filtered by tag")} && ${imgsLoaded}` },
  {
    id: "I5-items-select", path: "/items", as: "alex",
    steps: async (p) => {
      await must(p, listItems(5), "list");
      await click(p, "main .btn", "Select");
      await click(p, "main .list-item", "Projector");
      await click(p, "main .list-item", "Desk lamp");
    },
    ready: `(document.querySelector(".bulkbar")?.innerText || "").includes("2 selected") && ${imgsLoaded}`,
  },
  // a search without result says "No objects yet" (pinned wording, TESTING.md)
  { id: "I6-items-no-match", path: "/items?q=zzz", as: "alex", ready: `${listItems(0)} && ${text("No objects yet")}` },

  { id: "D1-item-detail", path: "/items/1", as: "alex", ready: `${text("Camera tripod")} && ${text("€129.99")} && ${text("Shelf 1")} && ${imgsLoaded}` },
  { id: "D2-item-out-of-storage", path: "/items/4", as: "alex", ready: `${text("Folding table")} && ${text("Place in storage…")} && ${text("No tags.")}` },
  {
    id: "D3-item-add-tag", path: "/items/2", as: "alex",
    steps: async (p) => { await must(p, text("Canvas 80x60"), "detail"); await click(p, "button", "+ Tag"); },
    ready: `${text("+ Fragile")} && ${text("+ Loaned")}`,
  },
  { id: "D4-item-archived", path: "/items/6", as: "alex", ready: `${text("Broken chair")} && ${text("Archived. Restore it")}` },
  { id: "D5-item-not-found", path: "/items/999", as: "alex", ready: `!!document.querySelector("main .error")` },
  { id: "F1-item-new", path: "/items/new", as: "alex", ready: `${text("New object")} && ${text("A new code will be allocated")}` },
  { id: "F2-item-edit", path: "/items/1/edit", as: "alex", ready: `${text("Edit object")} && document.querySelector("#n")?.value === "Camera tripod" && ${imgsLoaded}` },
  {
    id: "F3-item-scan-label", path: "/items/new", as: "alex", viewport: true,
    steps: async (p) => { await must(p, text("New object"), "form"); await click(p, "button", "Scan label"); },
    ready: `!!${modal} && ${modal}.innerText.includes("Scan this object") && !!${modal}.querySelector(".notice form input")`,
  },

  // ---------- places ----------
  { id: "P1-places", path: "/places", as: "alex", ready: `${listItems(2)} && ${text("Garage")} && ${text("Unit 12")}` },
  { id: "P2-place-detail", path: "/places/1", as: "alex", ready: `${text("Nested places")} && ${text("Shelf 2")} && ${text("Projector")} && ${imgsLoaded}` },
  { id: "P3-place-nested", path: "/places/2", as: "alex", ready: `${text("Inside:")} && ${text("Camera tripod")} && ${imgsLoaded}` },
  { id: "P4-place-archived", path: "/places/5", as: "alex", ready: `${text("Old cabinet")} && ${text("Archived. Restore it")}` },
  { id: "P5-place-new", path: "/places/new", as: "alex", ready: text("New place") },
  { id: "P6-place-edit", path: "/places/1/edit", as: "alex", ready: `${text("Edit place")} && document.querySelector("input")?.value !== "" && ${imgsLoaded}` },
  { id: "P7-places-by-tag", path: "/places?tag=1", as: "alex", ready: `${text("Places tagged")} && ${listItems(1)}` },

  // ---------- tags, labels, history ----------
  { id: "T1-tags", path: "/tags", as: "alex", ready: `${text("Expo Lyon 2026")} && ${text("Loaned")} && ${text("Fragile")}` },
  { id: "LB1-labels", path: "/labels", as: "alex", ready: text("Generate 24 object labels (PDF)") },
  {
    id: "LB2-labels-place", path: "/labels", as: "alex",
    steps: async (p) => { await click(p, "button", "Place (PLC-"); },
    ready: text("Generate 24 place labels (PDF)"),
  },
  { id: "H1-history", path: "/history", as: "alex", ready: `${text("Archived")} && ${text("Created")} && ${text("Tagged")}` },
  { id: "H2-history-item", path: "/history?entity_type=item&entity_id=1", as: "alex", ready: `${text("item #1")} && ${text("Tagged")}` },

  // ---------- admin ----------
  { id: "A1-admin", path: "/admin", as: "alex", ready: `${text("Not configured.")} && ${text("Export .xlsx")}` },
  { id: "A2-archive", path: "/archive", as: "alex", ready: `${text("Old cabinet")} && ${text("Broken chair")}` },
  { id: "U1-users", path: "/users", as: "alex", ready: `${text("marie")} && ${text("(you)")} && ${text("last login: never")}` },
  {
    id: "U2-users-password", path: "/users", as: "alex",
    steps: async (p) => {
      await must(p, text("marie"), "users");
      await must(p, `(() => { const c = [...document.querySelectorAll(".card")].find((x) => x.querySelector("b")?.textContent === "marie");
        const b = c && [...c.querySelectorAll("button")].find((x) => x.textContent === "Password"); if (!b) return false; b.click(); return true; })()`, "marie's Password");
    },
    ready: `!!document.querySelector("input[placeholder='New password (min 8)']")`,
  },

  // ---------- phase "mutating": last ----------
  {
    // CONFIRM moves the object; before each width the object is put back out of storage (API)
    id: "M1-scan-confirm-move", phase: "mutating", path: "/", as: "alex",
    before: (ctx) => ctx.resetFoldingTable(),
    steps: async (p) => {
      await enterCode(p, "OBJ-000004");
      await must(p, `${preview}.includes("Folding table")`, "object added");
      await enterCode(p, "PLC-000004");
      await must(p, `!document.querySelector(".bigbtn.confirm").disabled`, "confirm enabled");
      await click(p, ".bigbtn.confirm", "CONFIRM");
    },
    ready: `${preview}.includes("Moved 1 object to Garage.")`,
  },
];

export const PHASES = ["fresh", "empty", "seeded", "mutating"];
