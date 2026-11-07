// Small-cell class vote: no dependencies, Node 18+.
// GET /            ballot (question + options)
// GET /results     projector page (map bubbles + coloured word cloud)
// POST /api/vote   {voter, site, word}
// GET /api/stream  server-sent events with the current tally
// POST /api/clear  header x-admin-key: ADMIN_KEY
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "votes.json");
const SITES = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
// Short words shown in the word cloud; must match the ballot's option values.
const REASONS = ["Most people nearby", "Busy shops and offices", "Keeps commuters connected", "Handles game-day surges", "Emergency calls must work", "Students need to get online", "Residents lack good signal", "Fairer coverage for the Bronx", "Fills a coverage gap", "Easiest to get approved"];
const PUB =path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

let votes = {}; // voterId -> {site, word, t}
try { votes = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { votes = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(votes), () => {}), 300);
}

function norm(w) {
  return String(w || "").toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
}
function snapshot() {
  const bySite = Object.fromEntries(SITES.map((s) => [s, 0]));
  const words = {};
  for (const v of Object.values(votes)) {
    bySite[v.site]++;
    for (const w of v.words || []) { const k = v.site + "|" + w; words[k] = (words[k] || 0) + 1; }
  }
  return {
    total: Object.keys(votes).length,
    bySite,
    words: Object.entries(words).map(([k, c]) => ({ site: k[0], word: k.slice(2), count: c })),
  };
}

const clients = new Set();
let pushTimer = null;
function broadcast() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const msg = "data: " + JSON.stringify(snapshot()) + "\n\n";
    for (const res of clients) res.write(msg);
  }, 150);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/vote") {
    const { voter, site, reasons, other } = await readBody(req);
    if (typeof voter !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(voter)) return send(res, 400, { error: "bad voter" });
    if (!SITES.includes(site)) return send(res, 400, { error: "Choose a site." });
    const picked = [...new Set((Array.isArray(reasons) ? reasons : []).filter((r) => REASONS.includes(r)))].slice(0, 3);
    const own = [...new Set((Array.isArray(other) ? other : [other]).map(norm).filter(Boolean))].slice(0, 3);
    if (!picked.length && !own.length) return send(res, 400, { error: "Pick a reason or write your own." });
    votes[voter] = { site, reasons: picked, other: own, words: [...picked, ...own], t: Date.now() };
    persist(); broadcast();
    return send(res, 200, { ok: true, site, reasons: picked, other: own });
  }
  if (req.method === "GET" && p === "/api/me") {
    const v = votes[url.searchParams.get("voter")];
    return send(res, 200, v ? { site: v.site, reasons: v.reasons || [], other: v.other || [] } : {});
  }
  if (req.method === "GET" && p === "/api/results") return send(res, 200, snapshot());
  if (req.method === "GET" && p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("data: " + JSON.stringify(snapshot()) + "\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && p === "/api/clear") {
    if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) return send(res, 403, { error: "Wrong key." });
    votes = {}; persist(); broadcast();
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/healthz") return send(res, 200, "ok", "text/plain");

  // static
  const file = p === "/" ? "vote.html" : p === "/results" ? "results.html" : p.slice(1);
  const full = path.join(PUB, path.normalize(file));
  if (!full.startsWith(PUB)) return send(res, 404, "Not found", "text/plain");
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream", "Cache-Control": full.endsWith(".html") ? "no-cache" : "public, max-age=300" });
    res.end(buf);
  });
});
server.listen(PORT, () => console.log("Listening on " + PORT));
