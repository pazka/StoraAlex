// Minimal Chrome DevTools Protocol client: Node built-ins only (fetch, WebSocket, http).
// Same approach as pazka/hosh-hub tools/interact.mjs and the visual/cdp.mjs of pazka/lbgca, pazka/DrawTogether,
// pazka/MyMurderParty: no package is installed for the visual harness.
//
// StorAlex specifics: one origin serves the PWA, the API and /media (src/server/app.ts). In production the
// session cookie is `__Host-storalex_sid` (Secure, SameSite=Strict), which a browser only keeps on a secure
// context, so the pages are opened at http://localhost:<port> (Chrome treats localhost as secure; the image's
// port is published on 127.0.0.1 only). Every other host name resolves to nothing (RESOLVER_RULES): no request
// can leave the runner.
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

export const RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE localhost";

/** One request to the container (node:http), for seeding. Returns { status, headers, body: Buffer }. */
export function apiCall(app, method, path, { headers = {}, body } = {}) {
  const u = new URL(app);
  return new Promise((res, rej) => {
    const r = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** Connects to a Chrome started with --remote-debugging-port=<cdpPort> (visual/run.sh). */
export async function connect(cdpPort) {
  let info;
  for (let i = 0; i < 300 && !info; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); }
    catch { await sleep(100); }
  }
  if (!info) throw new Error(`no Chrome DevTools endpoint on 127.0.0.1:${cdpPort}`);
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(`${d.error.message}`)) : res(d.result);
    } else for (const l of listeners) l(d);
  };
  const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  /**
   * A new tab in its own browser context (own cookies, no service worker = a fresh visitor).
   * init: a script run in every document before the page's own scripts (visual/cases.mjs FREEZE_JS).
   * headers: extra request headers (visual/shoot.mjs: one X-Forwarded-For per shot, see there).
   * apiDown: every /api/ and /media/ request fails (connection refused); the PWA files still load.
   */
  async function page({ init, headers, apiDown = false } = {}) {
    const { browserContextId } = await raw("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await raw("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => raw(method, params, sessionId);
    const errors = [];
    const requests = []; // "<method> <path> -> <status>" of every finished request (report.json)
    const inflight = new Map();
    listeners.add((d) => {
      if (d.sessionId !== sessionId) return;
      const p = d.params;
      if (d.method === "Network.requestWillBeSent") inflight.set(p.requestId, `${p.request.method} ${new URL(p.request.url).pathname}`);
      if (d.method === "Network.responseReceived" && inflight.has(p.requestId)) {
        requests.push(`${inflight.get(p.requestId)} -> ${p.response.status}`);
      }
      if (d.method === "Network.loadingFinished") inflight.delete(p.requestId);
      if (d.method === "Network.loadingFailed") {
        if (inflight.has(p.requestId)) requests.push(`${inflight.get(p.requestId)} -> failed (${p.errorText})`);
        inflight.delete(p.requestId);
      }
      if (d.method === "Fetch.requestPaused") {
        raw("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" }, sessionId).catch(() => {});
      }
      if (d.method === "Runtime.exceptionThrown") {
        errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
      }
      if (d.method === "Page.javascriptDialogOpening") {
        errors.push(`dialog ${p.type}: ${p.message}`);
        raw("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
      }
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    if (headers) await send("Network.setExtraHTTPHeaders", { headers });
    if (apiDown) {
      await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }, { urlPattern: "*/media/*", requestStage: "Request" }] });
    }
    if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (expression, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { if (await evaluate(expression)) return true; } catch { /* navigating */ }
        await sleep(50);
      }
      return false;
    };
    // no request in flight for `quiet` ms (react-query fires its calls in chains: me, then the page's data)
    const idle = async (quiet = 300, ms = 10000) => {
      const end = Date.now() + ms;
      let since = Date.now(), n = requests.length;
      while (Date.now() < end) {
        if (inflight.size || requests.length !== n) { since = Date.now(); n = requests.length; }
        else if (Date.now() - since >= quiet) return true;
        await sleep(25);
      }
      return false;
    };
    const goto = async (href) => {
      await send("Page.navigate", { url: href });
      await sleep(100);
      if (!(await waitFor("document.readyState === 'complete'"))) throw new Error(`page did not load: ${href}`);
      await evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    };
    const close = async () => { await raw("Target.closeTarget", { targetId }).catch(() => {}); };
    return { send, evaluate, waitFor, idle, goto, close, errors, requests };
  }

  function close() {
    try { ws.close(); } catch { /* closed */ }
  }
  return { page, close, version: info.Browser };
}
