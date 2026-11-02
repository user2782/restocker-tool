/* Restock Counter — self-hosted server
 * Zero npm dependencies: plain Node.js (v16+).
 * Data lives in ./data/db.json (created automatically).
 *
 * Run:            node server.js
 * Custom port:    PORT=8080 node server.js
 * Manager PIN:    ADMIN_PIN=4321 node server.js   (protects catalog edits + clearing counts)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_VERSION = "v3.41";
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const SETUP_LOG_DIR = path.join(DATA_DIR, "setup-log");
const FIXES_FILE = path.join(DATA_DIR, "archive-fixes.json");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const PHOTO_INDEX = path.join(PHOTO_DIR, "index.json");
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;     // phones shrink photos first (~150 KB); this is only a ceiling
const PUBLIC_DIR = path.join(__dirname, "public");

const DEFAULT_DB = {
  catalog: {
    stores: ["Main St", "Riverside", "Northgate"],
    categories: [
      { name: "Produce", items: ["Bananas","Apples (Gala)","Oranges (Navel)","Strawberries","Grapes (Red)","Lettuce (Romaine)","Tomatoes","Potatoes (Russet)","Onions (Yellow)","Carrots"] },
      { name: "Meat",    items: ["Chicken Breast","Chicken Thighs","Ground Beef","Beef Striploin","Pork Chops","Bacon","Breakfast Sausage","Sliced Ham","Turkey Breast"] },
      { name: "Seafood", items: ["Atlantic Salmon","Tilapia Fillets","Shrimp (Raw 21/25)","Cod Fillets","Mussels","Canned Tuna","Smoked Salmon"] },
      { name: "Dairy",   items: ["Milk 2% 4L","Milk Whole 4L","Eggs (Dozen)","Butter (Salted)","Cheddar Block","Mozzarella Shredded","Yogurt (Plain)","Sour Cream","Cream Cheese"] },
      { name: "Pantry",  items: ["White Bread","Whole Wheat Bread","Bagels","Rice (Long Grain)","Pasta (Spaghetti)","Canned Tomatoes","Cereal (Oat Rings)","Orange Juice","Cooking Oil","Sugar"] }
    ],
    restockers: [
      { name: "Produce buyer", items: ["Bananas","Apples (Gala)","Oranges (Navel)","Strawberries","Grapes (Red)","Lettuce (Romaine)","Tomatoes","Potatoes (Russet)","Onions (Yellow)","Carrots"] },
      { name: "Butcher run",   items: ["Chicken Breast","Chicken Thighs","Ground Beef","Beef Striploin","Pork Chops","Bacon","Breakfast Sausage","Sliced Ham","Turkey Breast"] },
      { name: "Fish market",   items: ["Atlantic Salmon","Tilapia Fillets","Shrimp (Raw 21/25)","Cod Fillets","Mussels","Canned Tuna","Smoked Salmon"] }
    ]
  },
  prices: {},   // item -> cost per case (one price per item, shared)
  restocks: {} // storeSlug -> { store, counts:{item:n}, updatedAt }
};

/* ---------- tiny JSON-file database with atomic writes ---------- */
let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!db.catalog || !db.restocks) throw new Error("bad shape");
    // migrate older single-list catalogs into one category
    if (!db.prices || typeof db.prices !== "object") { db.prices = {}; saveDb(); }
    if (!Array.isArray(db.catalog.restockers)) { db.catalog.restockers = []; saveDb(); }
    if (!Array.isArray(db.catalog.categories)) {
      const legacy = Array.isArray(db.catalog.items) ? db.catalog.items : [];
      db.catalog.categories = [{ name: "All items", items: legacy }];
      delete db.catalog.items;
      saveDb();
    }
  } catch (e) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    saveDb();
  }
}
let saveTimer = null;
function writeDbNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error("Failed to save db:", e.message);
  }
}
function saveDb() {
  // debounce rapid writes, then write atomically (tmp file + rename)
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeDbNow(); }, 150);
}
// a stop or restart (systemctl restart, Ctrl-C) must not lose a save made a moment earlier
function flushAndExit() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeDbNow(); }
  process.exit(0);
}
process.on("SIGTERM", flushAndExit);
process.on("SIGINT", flushAndExit);

const qtyOf = v => Math.max(0, Math.min(999, Math.round((Number(v) || 0) * 2) / 2));   // whole or half cases, 0-999
const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "store";

/* ---------- helpers ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function adminOk(req) {
  if (!ADMIN_PIN) return true;
  return (req.headers["x-admin-pin"] || "") === ADMIN_PIN;
}
/* Two names are "the same" if they match ignoring case and extra spaces. */
const normKey = s => String(s).trim().replace(/\s+/g, " ").toLowerCase();

function cleanNames(list, max) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().slice(0, 120);
    if (!s || seen.has(normKey(s))) continue;
    seen.add(normKey(s));
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}


/* ---------- duplicate checks ----------
   groups: [{ label, items: [names] }]. Returns every name that shows up more than
   once across (or within) the groups, with where it was found. Used to refuse a
   save that would put the same item on two pages, or hand one item to two people. */
function findDuplicates(groups) {
  const map = new Map();
  groups.forEach((g, gi) => {
    for (const raw of g.items || []) {
      if (typeof raw !== "string") continue;
      const name = raw.trim().slice(0, 120);
      if (!name) continue;
      const k = normKey(name);
      let e = map.get(k);
      if (!e) { e = { name, total: 0, holders: [] }; map.set(k, e); }
      e.total++;
      let h = e.holders.find(x => x.gi === gi);
      if (!h) { h = { gi, label: g.label, count: 0 }; e.holders.push(h); }
      h.count++;
    }
  });
  return [...map.values()].filter(e => e.total > 1)
    .map(e => ({ name: e.name, holders: e.holders.map(h => ({ label: h.label, count: h.count })) }));
}
function dupeMessage(kind, dupes) {
  const shown = dupes.slice(0, 5).map(d => `${d.name} (${d.holders.map(h => h.label).join(" + ")})`).join("; ");
  const more = dupes.length > 5 ? ` and ${dupes.length - 5} more` : "";
  return (kind === "people" ? "An item can only be assigned to one person. Assigned more than once: "
                            : "Each item can appear only once. Listed more than once: ") + shown + more;
}
function duplicatePersonNames(people) {
  const seen = new Map(), out = [];
  for (const p of people) {
    const k = normKey(p.name);
    if (seen.has(k)) { if (!out.includes(seen.get(k))) out.push(seen.get(k)); }
    else seen.set(k, p.name);
  }
  return out;
}
/* After a rename, only complain about duplicates the rename itself created; ones already present
   (v3.18 allowed them) must not block an unrelated rename. */
function newPeopleDuplicates(beforePeople, afterPeople) {
  const had = new Set(findDuplicates(beforePeople.map(p => ({ label: p.name, items: p.items }))).map(d => normKey(d.name)));
  return findDuplicates(afterPeople.map(p => ({ label: p.name, items: p.items }))).filter(d => !had.has(normKey(d.name)));
}
/* Duplicates in a catalog as it stands (used after a restore, which is exact). */
function catalogDuplicates(cat) {
  return {
    items: findDuplicates((cat.categories || []).map(c => ({ label: c.name, items: c.items }))),
    people: findDuplicates((cat.restockers || []).map(p => ({ label: p.name, items: p.items }))),
    personNames: duplicatePersonNames(cat.restockers || [])
  };
}

/* ---------- setup log ----------
   Every change to sections/items, people or stores is written to its own file in
   data/setup-log/ holding the complete setup as it was AFTER the change, plus a
   plain list of what changed. Restoring an old entry never deletes anything: it
   becomes a new entry, so a restore can itself be undone. As with archived cycles,
   nothing in the app can erase a log entry. */
const clone = o => JSON.parse(JSON.stringify(o));
const setupOf = cat => ({
  stores: clone(cat.stores || []),
  categories: clone(cat.categories || []),
  restockers: clone(cat.restockers || [])
});
const setupCounts = cat => ({
  stores: (cat.stores || []).length,
  sections: (cat.categories || []).length,
  items: (cat.categories || []).reduce((a, c) => a + c.items.length, 0),
  people: (cat.restockers || []).length
});
const sameSetup = (a, b) => JSON.stringify(setupOf(a)) === JSON.stringify(setupOf(b));

const NAMES_SHOWN = 6;
const sample = names => names.slice(0, NAMES_SHOWN);

/* What changed going from catalog `a` to catalog `b`, as structured records the
   page words itself (so the log reads in English or Chinese). Each has an area. */
function diffSetup(a, b) {
  const out = [];
  const add = (area, k, rest) => out.push(Object.assign({ area, k }, rest));

  // stores
  {
    const A = a.stores || [], B = b.stores || [];
    const ak = new Set(A.map(normKey)), bk = new Set(B.map(normKey));
    const added = B.filter(x => !ak.has(normKey(x))), removed = A.filter(x => !bk.has(normKey(x)));
    if (added.length) add("stores", "storesAdded", { n: added.length, names: sample(added) });
    if (removed.length) add("stores", "storesRemoved", { n: removed.length, names: sample(removed) });
    const common = (L, other) => L.filter(x => other.has(normKey(x))).map(normKey);
    if (!added.length && !removed.length && JSON.stringify(common(A, bk)) !== JSON.stringify(common(B, ak)))
      add("stores", "storesOrder", {});
  }

  // sections + items
  {
    const A = a.categories || [], B = b.categories || [];
    const sig = c => JSON.stringify(c.items.map(normKey).sort());
    const unA = A.filter(ca => !B.some(cb => normKey(cb.name) === normKey(ca.name)));
    const unB = B.filter(cb => !A.some(ca => normKey(ca.name) === normKey(cb.name)));
    // a renamed section keeps exactly the same items
    for (const ca of [...unA]) {
      const m = unB.find(cb => sig(cb) === sig(ca) && ca.items.length > 0);
      if (m) {
        add("items", "sectionRenamed", { from: ca.name, to: m.name });
        unA.splice(unA.indexOf(ca), 1); unB.splice(unB.indexOf(m), 1);
      }
    }
    for (const c of unB) add("items", "sectionAdded", { name: c.name, n: c.items.length });
    for (const c of unA) add("items", "sectionRemoved", { name: c.name, n: c.items.length });
    const where = cats => { const m = new Map(); for (const c of cats) for (const it of c.items) m.set(normKey(it), { name: it, sec: c.name }); return m; };
    const wa = where(A), wb = where(B);
    const itemsAdded = [], itemsRemoved = [], moved = [];
    for (const [k, v] of wb) if (!wa.has(k)) itemsAdded.push(v.name);
    for (const [k, v] of wa) if (!wb.has(k)) itemsRemoved.push(v.name);
    for (const [k, v] of wb) {
      const o = wa.get(k);
      if (o && normKey(o.sec) !== normKey(v.sec) && !unA.some(c => c.name === o.sec) && !unB.some(c => c.name === v.sec)
          && !out.some(x => x.k === "sectionRenamed" && x.from === o.sec))
        moved.push(v.name);
    }
    if (itemsAdded.length) add("items", "itemsAdded", { n: itemsAdded.length, names: sample(itemsAdded) });
    if (itemsRemoved.length) add("items", "itemsRemoved", { n: itemsRemoved.length, names: sample(itemsRemoved) });
    if (moved.length) add("items", "itemsMoved", { n: moved.length, names: sample(moved) });
    // order only matters if nothing else about sections/items changed
    if (!out.some(x => x.area === "items")) {
      if (JSON.stringify(A.map(c => normKey(c.name))) !== JSON.stringify(B.map(c => normKey(c.name))))
        add("items", "sectionOrder", {});
      else if (JSON.stringify(A.map(c => c.items.map(normKey))) !== JSON.stringify(B.map(c => c.items.map(normKey))))
        add("items", "itemOrder", {});
    }
  }

  // people + who is responsible for what
  {
    const A = a.restockers || [], B = b.restockers || [];
    const psig = p => JSON.stringify(p.items.map(normKey).sort());
    const unA = A.filter(pa => !B.some(pb => normKey(pb.name) === normKey(pa.name)));
    const unB = B.filter(pb => !A.some(pa => normKey(pa.name) === normKey(pb.name)));
    const renames = new Map(); // old key -> new name
    for (const pa of [...unA]) {
      const m = unB.find(pb => psig(pb) === psig(pa) && pa.items.length > 0);
      if (m) {
        add("people", "personRenamed", { from: pa.name, to: m.name });
        renames.set(normKey(pa.name), m.name);
        unA.splice(unA.indexOf(pa), 1); unB.splice(unB.indexOf(m), 1);
      }
    }
    for (const p of unB) add("people", "personAdded", { name: p.name, n: p.items.length });
    for (const p of unA) add("people", "personRemoved", { name: p.name, n: p.items.length });

    const owners = list => { const m = new Map(); for (const p of list) for (const it of p.items) if (!m.has(normKey(it))) m.set(normKey(it), { name: it, who: p.name }); return m; };
    const oa = owners(A), ob = owners(B);
    const canon = who => renames.has(normKey(who)) ? renames.get(normKey(who)) : who;
    const moves = new Map(), gained = new Map(), lost = new Map();
    const push = (map, key, name) => { if (!map.has(key)) map.set(key, []); map.get(key).push(name); };
    for (const [k, v] of ob) {
      const o = oa.get(k);
      if (!o) push(gained, v.who, v.name);
      else if (normKey(canon(o.who)) !== normKey(v.who)) push(moves, canon(o.who) + "\u0000" + v.who, v.name);
    }
    for (const [k, v] of oa) if (!ob.has(k)) push(lost, canon(v.who), v.name);
    for (const [key, names] of moves) {
      const [from, to] = key.split("\u0000");
      add("people", "reassigned", { from, to, n: names.length, names: sample(names) });
    }
    for (const [who, names] of gained) add("people", "assigned", { person: who, n: names.length, names: sample(names) });
    for (const [who, names] of lost) add("people", "unassigned", { person: who, n: names.length, names: sample(names) });
    if (!out.some(x => x.area === "people") &&
        JSON.stringify(A.map(p => normKey(p.name))) !== JSON.stringify(B.map(p => normKey(p.name))))
      add("people", "personOrder", {});
  }
  // Lists can differ in ways the checks above don't describe (an extra copy removed from a list,
  // spelling/capitals, order inside a list). Still a real change: never report "nothing changed".
  const j = x => JSON.stringify(x);
  if (!out.some(x => x.area === "stores") && j(a.stores || []) !== j(b.stores || [])) add("stores", "listsEdited", {});
  if (!out.some(x => x.area === "items") && j(a.categories || []) !== j(b.categories || [])) add("items", "listsEdited", {});
  if (!out.some(x => x.area === "people") && j(a.restockers || []) !== j(b.restockers || [])) add("people", "listsEdited", {});
  return out;
}

/* ---------- renames ----------
   Counts, saved costs and each person's list are all keyed by item NAME, so changing
   a name in the catalog alone leaves them behind under the old one (the item then shows
   as "Other", unassigned and uncosted). A rename therefore moves all of them together. */
function mapperOf(renames) {
  const m = new Map(renames.map(r => [normKey(r.from), r.to]));
  return s => (m.has(normKey(s)) ? m.get(normKey(s)) : s);
}
function uniqByKey(list) {
  const seen = new Set(), out = [];
  for (const x of list) { const k = normKey(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
/* Validate [{from,to}] against the catalog it will live in: `to` must be a catalog item,
   `from` must no longer be one (otherwise it isn't a rename). */
function planRenames(raw, setup) {
  if (raw === undefined) return { renames: [] };
  if (!Array.isArray(raw) || raw.length > 200) return { error: "bad rename list" };
  const inCat = new Map();
  for (const c of setup.categories) for (const it of c.items) inCat.set(normKey(it), it);
  const out = [], seenFrom = new Set(), seenTo = new Set();
  for (const r of raw) {
    if (!r || typeof r.from !== "string" || typeof r.to !== "string") return { error: "bad rename list" };
    const from = r.from.trim().slice(0, 120), toIn = r.to.trim().slice(0, 120);
    if (!from || !toIn) return { error: "bad rename list" };
    const to = inCat.get(normKey(toIn));
    if (!to) return { error: `"${toIn}" is not in the catalog, so nothing can be renamed to it` };
    if (from === to) continue;
    const caseOnly = normKey(from) === normKey(to);
    if (!caseOnly && inCat.has(normKey(from))) return { error: `"${from}" is still in the catalog, so it was not renamed` };
    if (seenFrom.has(normKey(from))) continue;
    if (!caseOnly && seenTo.has(normKey(to))) return { error: `Two items can't both be renamed to "${to}"` };
    seenFrom.add(normKey(from)); if (!caseOnly) seenTo.add(normKey(to));
    out.push({ from, to });
  }
  return { renames: out };
}
/* People's lists, saved costs and store counts after the renames. Pure: returns copies. */
function cascadeRenames(people, prices, restocks, renames) {
  const map = mapperOf(renames);
  const newPeople = people.map(p => ({ name: p.name, items: uniqByKey(p.items.map(map)) }));
  const newPrices = {};
  const moved = [];
  for (const [k, v] of Object.entries(prices || {})) { const nk = map(k); if (nk === k) newPrices[k] = v; else moved.push([nk, v]); }
  for (const [nk, v] of moved) if (!(nk in newPrices)) newPrices[nk] = v;
  const newRestocks = {};
  for (const [slugKey, sub] of Object.entries(restocks || {})) {
    const counts = {};
    for (const [k, n] of Object.entries(sub.counts || {})) { const nk = map(k); counts[nk] = (counts[nk] || 0) + n; }
    newRestocks[slugKey] = Object.assign({}, sub, { counts });
  }
  return { people: newPeople, prices: newPrices, restocks: newRestocks };
}
/* The old setup as it would read after the renames, so the log shows "renamed", not "removed + added". */
function renameInSetup(setup, renames) {
  const map = mapperOf(renames);
  return {
    stores: setup.stores,
    categories: setup.categories.map(c => ({ name: c.name, items: c.items.map(map) })),
    restockers: setup.restockers.map(p => ({ name: p.name, items: uniqByKey(p.items.map(map)) }))
  };
}
/* An archived cycle with the owner's name-matches applied (the archive file itself is never edited). */
function applyNameMap(a, map) {
  const renames = Object.entries(map || {}).map(([from, to]) => ({ from, to }));
  if (!renames.length) return a;
  const c = cascadeRenames((a.catalog && a.catalog.restockers) || [], a.prices || {}, a.restocks || {}, renames);
  return Object.assign({}, a, { restocks: c.restocks, prices: c.prices, catalog: Object.assign({}, a.catalog, { restockers: c.people }), nameMap: map });
}

function logId(now) { return now.toISOString().replace(/[:.]/g, "-").replace("T", "-").replace("Z", ""); }

/* Write one log entry. Throws if it can't be written. */
function writeSetupLog(kind, changes, catalog, extra) {
  fs.mkdirSync(SETUP_LOG_DIR, { recursive: true });
  const now = new Date();
  let id = logId(now), n = 2;
  while (fs.existsSync(path.join(SETUP_LOG_DIR, id + ".json"))) id = logId(now) + "-" + n++;
  const entry = Object.assign({ id, at: now.toISOString(), kind, changes, counts: setupCounts(catalog), catalog: setupOf(catalog) }, extra || {});
  const file = path.join(SETUP_LOG_DIR, id + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return entry;
}
function logFiles() {
  try { return fs.readdirSync(SETUP_LOG_DIR).filter(f => /^[\w.\-]+\.json$/.test(f)).sort(); } catch (e) { return []; }
}
function readSetupLog(id) {
  const name = path.basename(String(id)) ;
  if (!/^[\w.\-]+$/.test(name)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(SETUP_LOG_DIR, name + ".json"), "utf8")); } catch (e) { return null; }
}

/* ---------- archives with name-matches ----------
   Matches made in the history view live in data/archive-fixes.json, never inside the
   archive files, which stay exactly as they were written. */
function loadFixes() {
  try { const f = JSON.parse(fs.readFileSync(FIXES_FILE, "utf8")); return f && typeof f === "object" ? f : {}; } catch (e) { return {}; }
}
function saveFixes(f) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FIXES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, FIXES_FILE);
}
function readArchiveRaw(name) { return JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, name), "utf8")); }
function loadArchive(name) {
  const raw = readArchiveRaw(name);
  return applyNameMap(raw, loadFixes()[name]);
}
/* On every start: if there is no log yet, or the saved setup no longer matches the
   newest entry (db.json was edited by hand or restored from a backup), record the
   setup as found, so there is always an entry matching what is live. */
function ensureLogBaseline() {
  try {
    const files = logFiles();
    const latest = files.length ? readSetupLog(files[files.length - 1].replace(/\.json$/, "")) : null;
    if (!latest || !sameSetup(latest.catalog, db.catalog))
      writeSetupLog("baseline", latest ? diffSetup(latest.catalog, db.catalog) : [], db.catalog);
  } catch (e) { console.error("Could not start the setup log:", e.message); }
}


/* ---------- item photos ----------
   One photo per item, kept as files in data/photos/ with a small index (item name -> file).
   Separate from db.json on purpose: db.json keeps exactly its old shape, so older versions
   still read it, and a photo problem can never touch counts, costs or history.
   File names are a hash of the image, so a replaced photo gets a new address and phones
   never show a stale cached copy. Anyone can add, replace or remove a photo. An add (without
   ?replace=1) never overwrites: if two stores add the same item at once, the first one stays. */
let photos = {};
function loadPhotos() {
  try { const p = JSON.parse(fs.readFileSync(PHOTO_INDEX, "utf8")); photos = p && typeof p === "object" ? p : {}; }
  catch (e) { photos = {}; }
}
function savePhotos() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const tmp = PHOTO_INDEX + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(photos, null, 2));
  fs.renameSync(tmp, PHOTO_INDEX);
}
const photoUrls = () => Object.fromEntries(Object.entries(photos).map(([k, v]) => [k, "/photos/" + v.file]));
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: ".jpg", mime: "image/jpeg" };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: ".png", mime: "image/png" };
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return { ext: ".webp", mime: "image/webp" };
  return null;
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("photo too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
/* Delete a photo file once no item points at it any more. */
function dropPhotoFileIfUnused(file) {
  if (!file || Object.values(photos).some(v => v.file === file)) return;
  try { fs.unlinkSync(path.join(PHOTO_DIR, file)); } catch (e) {}
}
/* Keep photos attached to items that are renamed (same rule as counts and costs). */
function renamePhotos(renames) {
  if (!renames.length) return;
  const map = mapperOf(renames);
  let changed = false;
  for (const k of Object.keys(photos)) {
    const nk = map(k);
    if (nk !== k) { if (!photos[nk]) photos[nk] = photos[k]; delete photos[k]; changed = true; }
  }
  if (changed) { try { savePhotos(); } catch (e) { console.error("Could not save photo index:", e.message); } }
}
/* A light brake on uploads: a few per minute per device is plenty for staff taking photos,
   and it stops anything from flooding the Pi's disk. */
const uploadLog = new Map();
function uploadAllowed(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (uploadLog.get(ip) || []).filter(tm => now - tm < win);
  const total = [...uploadLog.values()].reduce((n, l) => n + l.filter(tm => now - tm < win).length, 0);
  if (list.length >= 150 || total >= 600) return false;
  list.push(now); uploadLog.set(ip, list);
  return true;
}
function servePhoto(req, res) {
  const name = path.basename(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) { res.writeHead(404); res.end(); return; }
  fs.readFile(path.join(PHOTO_DIR, name), (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const mime = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
    res.end(buf);
  });
}

/* ---------- stats ----------
   Every saved cycle in a compact form for the History reports: per-store quantities, the prices that
   cycle was costed with, and which section / person each counted item belonged to at the time.
   Plus every rename ever made, so the reports can count "Banana" and "Bananas" as one item. */
let renameHistory = null;                       // built from the setup log on first use, dropped after a rename
function loadRenameHistory() {
  renameHistory = [];
  for (const f of logFiles()) {
    const e = readSetupLog(f.replace(/\.json$/, ""));
    if (!e) continue;
    for (const c of e.changes || []) if (c.k === "itemRenamed") renameHistory.push({ from: c.from, to: c.to, at: e.at });
  }
}
function statsData() {
  let files = [];
  try { files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json")); } catch (e) {}
  const cycles = [];
  for (const f of files) {
    let a; try { a = loadArchive(f); } catch (e) { continue; }
    const used = new Set(), stores = {};
    for (const r of Object.values(a.restocks || {})) {
      const m = {};
      for (const [k, v] of Object.entries(r.counts || {})) { const n = Number(v); if (n > 0) { m[k] = n; used.add(k); } }
      if (Object.keys(m).length) stores[r.store || "?"] = Object.assign(stores[r.store || "?"] || {}, m);
    }
    const prices = {}, section = {}, owner = {};
    for (const k of used) { const p = Number((a.prices || {})[k]); if (isFinite(p) && p > 0) prices[k] = p; }
    for (const c of (a.catalog && a.catalog.categories) || []) for (const it of c.items) if (used.has(it) && !(it in section)) section[it] = c.name;
    for (const pr of (a.catalog && a.catalog.restockers) || []) for (const it of pr.items) if (used.has(it) && !(it in owner)) owner[it] = pr.name;
    cycles.push({ file: f, clearedAt: a.clearedAt || null, stores, prices, section, owner });
  }
  cycles.sort((x, y) => String(x.clearedAt).localeCompare(String(y.clearedAt)));
  if (!renameHistory) loadRenameHistory();
  return { cycles, renames: renameHistory };
}

/* ---------- backup, restore and export ----------
   Backup: ONE ZIP file with everything: backup.json (items, sections, stores, people, prices, the
   current counts, every saved cycle, the setup log, history name-matches) plus photos/ (optional).
   It is written to the download one file at a time, so the app keeps answering stores meanwhile.
   Restore: checks the file, saves a safety copy of what is on the Pi now (data/backups/), writes the
   backup's folders next to the live ones and then swaps them in, and reloads. Nothing is half-done.
   Export: a ZIP of CSV files (opens in Excel / Numbers / Sheets) for records and taxes. */
const zlib = require("zlib");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_META = path.join(DATA_DIR, "backup-meta.json");
const MAX_RESTORE_BYTES = 500 * 1024 * 1024;
const PHOTO_NAME = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
const JSON_NAME = /^[\w.\-]+\.json$/;

function readDirFiles(dir, re, asBase64) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names.sort()) {
    if (!re.test(n)) continue;
    try {
      const b = fs.readFileSync(path.join(dir, n));
      out[n] = asBase64 ? b.toString("base64") : JSON.parse(b.toString("utf8"));
    } catch (e) {}
  }
  return out;
}
function flushPendingSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeDbNow(); } }
function backupMeta1(includePhotos) {
  flushPendingSave();                                           // include a save made a moment ago
  return {
    format: "restock-backup", formatVersion: 2, appVersion: APP_VERSION, createdAt: new Date().toISOString(),
    includesPhotos: !!includePhotos,
    data: {
      db: { catalog: db.catalog, prices: db.prices || {}, restocks: db.restocks || {} },
      archives: readDirFiles(ARCHIVE_DIR, JSON_NAME, false),
      archiveFixes: loadFixes(),
      setupLog: readDirFiles(SETUP_LOG_DIR, JSON_NAME, false)
    }
  };
}
function* backupEntries(includePhotos) {
  const meta = backupMeta1(includePhotos);
  yield { name: "backup.json", data: Buffer.from(JSON.stringify(meta)), compress: true };
  if (includePhotos) {
    const snap = JSON.parse(JSON.stringify(photos));
    yield { name: "photos/index.json", data: Buffer.from(JSON.stringify(snap, null, 2)), compress: true };
    let names = []; try { names = fs.readdirSync(PHOTO_DIR).filter(n => PHOTO_NAME.test(n)).sort(); } catch (e) {}
    for (const n of names) { let d; try { d = fs.readFileSync(path.join(PHOTO_DIR, n)); } catch (e) { continue; } yield { name: "photos/" + n, data: d, compress: false }; }
  }
  yield { name: "README.txt", compress: true, data: Buffer.from([
    "Restock Counter backup", `Made: ${meta.createdAt} by ${APP_VERSION}`, "",
    "To use it: open the app > Manager > settings (gear) > Backup > Load a backup, and choose this file.",
    "backup.json holds items, stores, people, prices, the current counts, every saved cycle and the setup log.",
    "photos/ holds the item photos. Don't edit these files; load the backup as it is."].join("\r\n") + "\r\n") };
}
function backupSummary(b) {
  const d = (b && b.data) || {}, cat = (d.db && d.db.catalog) || {};
  return {
    createdAt: b.createdAt || null, appVersion: b.appVersion || null, includesPhotos: !!b.includesPhotos,
    sections: (cat.categories || []).length,
    items: (cat.categories || []).reduce((a, c) => a + ((c && c.items) || []).length, 0),
    people: (cat.restockers || []).length, stores: (cat.stores || []).length,
    prices: Object.keys((d.db && d.db.prices) || {}).length,
    openStores: Object.keys((d.db && d.db.restocks) || {}).length,
    cycles: Object.keys(d.archives || {}).length, setupLog: Object.keys(d.setupLog || {}).length,
    photos: b.__photoCount || 0
  };
}
function currentSummary() {
  let cycles = 0, logs = 0;
  try { cycles = fs.readdirSync(ARCHIVE_DIR).filter(f => JSON_NAME.test(f)).length; } catch (e) {}
  try { logs = logFiles().length; } catch (e) {}
  const cat = db.catalog;
  return { sections: cat.categories.length, items: cat.categories.reduce((a, c) => a + c.items.length, 0), people: (cat.restockers || []).length,
    stores: cat.stores.length, prices: Object.keys(db.prices || {}).length, openStores: Object.keys(db.restocks || {}).length,
    cycles, setupLog: logs, photos: Object.keys(photos).length };
}
function validateBackup(b) {
  if (!b || b.format !== "restock-backup" || !b.data) return "that file isn't a Restock Counter backup";
  if (Number(b.formatVersion) > 2) return "this backup was made by a newer version of the app; update the app first";
  const d = b.data, c = d.db && d.db.catalog;
  if (!c || !Array.isArray(c.categories) || !Array.isArray(c.stores)) return "the backup's item list is damaged";
  if (c.categories.some(x => !x || typeof x.name !== "string" || !Array.isArray(x.items))) return "the backup's sections are damaged";
  if (!d.db.restocks || typeof d.db.restocks !== "object") return "the backup's counts are damaged";
  for (const n of Object.keys(d.archives || {})) if (!JSON_NAME.test(n)) return "a saved cycle in the backup has a bad name";
  for (const n of Object.keys(d.setupLog || {})) if (!JSON_NAME.test(n)) return "a setup-log entry in the backup has a bad name";
  return null;
}
const deflateRawAsync = buf => new Promise((ok, bad) => zlib.deflateRaw(buf, (e, r) => e ? bad(e) : ok(r)));
const inflateRawAsync = (buf, max) => new Promise((ok, bad) => zlib.inflateRaw(buf, { maxOutputLength: max }, (e, r) => e ? bad(e) : ok(r)));
const zcrc = buf => (typeof zlib.crc32 === "function" ? zlib.crc32(buf) : crc32(buf)) >>> 0;
const nextTick = () => new Promise(r => setImmediate(r));
/* Write a ZIP to a stream entry by entry (photos stored as they are, text compressed), pausing
   between entries so requests from the stores are served meanwhile. Returns the bytes written. */
async function zipToStream(out, entries) {
  const central = [];
  let offset = 0;
  const put = async buf => { offset += buf.length; if (!out.write(buf)) await new Promise(r => out.once("drain", r)); };
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), comp = e.compress ? await deflateRawAsync(e.data) : e.data, crc = zcrc(e.data), at = offset;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(e.compress ? 8 : 0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    await put(lh); await put(name); await put(comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(e.compress ? 8 : 0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(at, 42);
    central.push(Buffer.concat([ch, name]));
    await nextTick();
  }
  const cd = Buffer.concat(central), cdAt = offset, end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdAt, 16);
  await put(cd); await put(end);
  return offset;
}
function zipIndex(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip");
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nlen), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24), crc: buf.readUInt32LE(p + 16), at: buf.readUInt32LE(p + 42) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
async function zipRead(buf, e) {
  if (buf.readUInt32LE(e.at) !== 0x04034b50) throw new Error("damaged zip");
  const start = e.at + 30 + buf.readUInt16LE(e.at + 26) + buf.readUInt16LE(e.at + 28);
  const raw = buf.subarray(start, start + e.csize);
  const data = e.method === 0 ? raw : e.method === 8 ? await inflateRawAsync(raw, 1024 * 1024 * 1024) : null;
  if (!data) throw new Error("unsupported zip");
  if (zcrc(data) !== e.crc) throw new Error("damaged file inside the backup");
  return data;
}
async function parseBackup(buf) {
  if (!(buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50)) return { error: "that file isn't a Restock Counter backup" };
  let idx;
  try { idx = zipIndex(buf); } catch (e) { return { error: "the file is damaged (couldn't open the zip)" }; }
  const main = idx.find(e => e.name === "backup.json");
  if (!main) return { error: "that file isn't a Restock Counter backup" };
  let b;
  try { b = JSON.parse((await zipRead(buf, main)).toString("utf8")); } catch (e) { return { error: "the file is damaged (" + e.message + ")" }; }
  const err = validateBackup(b);
  if (err) return { error: err };
  const photoEntries = idx.filter(e => /^photos\//.test(e.name) && PHOTO_NAME.test(e.name.slice(7)));
  if (idx.some(e => /^photos\//.test(e.name) && e.name !== "photos/index.json" && !PHOTO_NAME.test(e.name.slice(7)))) return { error: "a photo in the backup has a bad name" };
  b.__photoCount = photoEntries.length;
  return { backup: b, buf, photoEntries, photoIndex: idx.find(e => e.name === "photos/index.json") || null };
}
const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
function stageDir(real, files, encode) {
  const stage = real + ".restore-" + Date.now();
  fs.mkdirSync(stage, { recursive: true });
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(stage, n), encode(v));
  return stage;
}
async function applyRestore(parsed) {
  const b = parsed.backup;
  const stamp = stampNow();
  // 1. safety copy of everything that is here now (photos included)
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const safety = path.join(BACKUP_DIR, `before-restore-${stamp}.zip`);
  await new Promise(async (ok, bad) => {
    const ws = fs.createWriteStream(safety + ".tmp");
    ws.on("error", bad);
    try { await zipToStream(ws, backupEntries(true)); ws.end(() => { fs.renameSync(safety + ".tmp", safety); ok(); }); } catch (e) { bad(e); }
  });
  // 2. stage the backup's folders next to the live ones
  const d = b.data, stages = [];
  try {
    stages.push([ARCHIVE_DIR, stageDir(ARCHIVE_DIR, d.archives || {}, v => JSON.stringify(v, null, 2))]);
    stages.push([SETUP_LOG_DIR, stageDir(SETUP_LOG_DIR, d.setupLog || {}, v => JSON.stringify(v, null, 2))]);
    if (b.includesPhotos) {                                    // a backup made without photos leaves today's photos alone
      const p = stageDir(PHOTO_DIR, {}, v => v);
      stages.push([PHOTO_DIR, p]);
      for (const e of parsed.photoEntries) { fs.writeFileSync(path.join(p, e.name.slice(7)), await zipRead(parsed.buf, e)); await nextTick(); }
      const idx = parsed.photoIndex ? JSON.parse((await zipRead(parsed.buf, parsed.photoIndex)).toString("utf8")) : {};
      fs.writeFileSync(path.join(p, "index.json"), JSON.stringify(idx, null, 2));
    }
  } catch (e) {
    for (const [, st] of stages) fs.rmSync(st, { recursive: true, force: true });
    throw e;
  }
  // 3. swap each folder in, then the small files, then reload everything
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }  // an older pending save must not overwrite the restore
  for (const [real, st] of stages) {
    const old = real + ".old-" + stamp;
    if (fs.existsSync(real)) fs.renameSync(real, old);
    fs.renameSync(st, real);
    fs.rmSync(old, { recursive: true, force: true });
  }
  if (d.archiveFixes && Object.keys(d.archiveFixes).length) saveFixes(d.archiveFixes);
  else try { fs.unlinkSync(FIXES_FILE); } catch (e) {}
  db = { catalog: d.db.catalog, prices: d.db.prices || {}, restocks: d.db.restocks || {} };
  writeDbNow();
  loadDb();
  loadPhotos();
  renameHistory = null;
  return safety;
}
function safetyCopies() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter(n => /^[\w.\-]+\.zip$/.test(n)); } catch (e) {}
  return names.sort().reverse().map(n => { let st = null; try { st = fs.statSync(path.join(BACKUP_DIR, n)); } catch (e) {} return { name: n, bytes: st ? st.size : 0, at: st ? st.mtime.toISOString() : null }; });
}
function backupMeta() { try { return JSON.parse(fs.readFileSync(BACKUP_META, "utf8")); } catch (e) { return {}; } }
function noteBackup(bytes, withPhotos) {
  try { fs.writeFileSync(BACKUP_META, JSON.stringify({ lastBackupAt: new Date().toISOString(), bytes, withPhotos: !!withPhotos }, null, 2)); } catch (e) {}
}

/* ----- export: a ZIP of CSV files ----- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {                                       // files: [{ name, text }]
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.from(f.text, "utf8"), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const csvc = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvText = (head, rows) => "\uFEFF" + [head, ...rows].map(r => r.map(csvc).join(",")).join("\r\n") + "\r\n";   // BOM: Excel reads Chinese correctly
const money2 = n => (Math.round(n * 100) / 100).toFixed(2);
const exact = n => String(Math.round(n * 1000) / 1000);        // half cases x 2-decimal price: never more than 3 decimals
const numberMap = cat => { const m = {}; let n = 0; for (const c of (cat && cat.categories) || []) for (const it of c.items) if (!(it in m)) m[it] = ++n; return m; };
function describeChange(c) {
  const names = c.names ? c.names.join(", ") + (c.n > c.names.length ? ` and ${c.n - c.names.length} more` : "") : "";
  switch (c.k) {
    case "itemsAdded": return `Items added (${c.n}): ${names}`;
    case "itemsRemoved": return `Items removed (${c.n}): ${names}`;
    case "itemsMoved": return `Items moved between sections (${c.n}): ${names}`;
    case "itemRenamed": return `Item renamed: ${c.from} -> ${c.to}`;
    case "sectionAdded": return `Section added: ${c.name}`;
    case "sectionRemoved": return `Section removed: ${c.name}`;
    case "sectionRenamed": return `Section renamed: ${c.from} -> ${c.to}`;
    case "storesAdded": return `Stores added (${c.n}): ${names}`;
    case "storesRemoved": return `Stores removed (${c.n}): ${names}`;
    case "personAdded": return `Person added: ${c.name}`;
    case "personRemoved": return `Person removed: ${c.name}`;
    case "personRenamed": return `Person renamed: ${c.from} -> ${c.to}`;
    case "assigned": return `Assigned to ${c.person} (${c.n}): ${names}`;
    case "unassigned": return `Taken off ${c.person} (${c.n}): ${names}`;
    case "reassigned": return `Moved from ${c.from} to ${c.to} (${c.n}): ${names}`;
    case "listsEdited": return "Lists edited (extra copies removed, spelling or order changed)";
    case "storesOrder": return "Store order changed";
    case "sectionOrder": return "Section order changed";
    case "itemOrder": return "Item order changed";
    case "personOrder": return "Order of people changed";
    default: return c.k;
  }
}
function buildExport(year) {
  flushPendingSave();
  if (!renameHistory) loadRenameHistory();
  const cur = new Set(db.catalog.categories.flatMap(c => c.items));
  const rmap = new Map(); for (const r of renameHistory) rmap.set(normKey(r.from), r.to);
  const currentName = n => { let x = n, g = 0; while (!cur.has(x) && rmap.has(normKey(x)) && g++ < 25) x = rmap.get(normKey(x)); return x; };
  // every cycle: the saved ones plus the one in progress
  let files = [];
  try { files = fs.readdirSync(ARCHIVE_DIR).filter(f => JSON_NAME.test(f)); } catch (e) {}
  const cycles = [];
  for (const f of files) { try { const a = loadArchive(f); cycles.push({ when: a.clearedAt || null, status: "Cleared", a }); } catch (e) {} }
  cycles.sort((x, y) => String(x.when).localeCompare(String(y.when)));
  cycles.push({ when: null, status: "Current (not yet cleared)", a: { restocks: db.restocks, prices: db.prices, catalog: db.catalog } });
  const thisYear = new Date().getFullYear();
  const pick = cycles.filter(c => !year || (c.when ? new Date(c.when).getFullYear() === year : year === thisYear));
  const lines = [], cyc = [], byStoreCycle = [], stores = {}, items = {}, priceRows = [];
  for (const c of pick) {
    const a = c.a, NO = numberMap(a.catalog);
    const sec = {}, own = {};
    for (const s of (a.catalog && a.catalog.categories) || []) for (const it of s.items) if (!(it in sec)) sec[it] = s.name;
    for (const p of (a.catalog && a.catalog.restockers) || []) for (const it of p.items) if (!(it in own)) own[it] = p.name;
    const d = c.when ? c.when.slice(0, 10) : "", tm = c.when ? new Date(c.when).toTimeString().slice(0, 5) : "";
    let cc = 0, ck = 0, cp = 0, cu = 0; const cItems = new Set(); let cStores = 0;
    for (const r of Object.values(a.restocks || {})) {
      let sc = 0, sk = 0; const sItems = new Set();
      for (const [it, nRaw] of Object.entries(r.counts || {})) {
        const n = Number(nRaw); if (!(n > 0)) continue;
        const p = Number((a.prices || {})[it]), hasP = isFinite(p) && p > 0, line = hasP ? p * n : 0, now = currentName(it);
        lines.push([d, tm, c.status, r.store, NO[it] || "", it, now !== it ? now : "", sec[it] || "", own[it] || "", n, hasP ? money2(p) : "", hasP ? exact(line) : "", r.adj && (it in r.adj) ? r.adj[it] : ""]);
        sc += n; sk += line; sItems.add(it); cItems.add(it); if (hasP) cp += n; else cu += n;
        const I = items[now] || (items[now] = { sec: "", cases: 0, cost: 0, priced: 0, cycles: new Set() });
        I.cases += n; I.cost += line; if (hasP) I.priced += n; I.cycles.add(c); if (sec[it]) I.sec = sec[it];
      }
      if (sc > 0) {
        cStores++;
        byStoreCycle.push([d, c.status, r.store, sItems.size, sc, exact(sk)]);
        const S = stores[r.store] || (stores[r.store] = { cycles: 0, cases: 0, cost: 0, first: null, last: null });
        S.cycles++; S.cases += sc; S.cost += sk; if (d) { if (!S.first || d < S.first) S.first = d; if (!S.last || d > S.last) S.last = d; }
      }
      cc += sc; ck += sk;
    }
    for (const [it, pRaw] of Object.entries(a.prices || {})) { const p = Number(pRaw); if (p > 0 && cItems.has(it)) priceRows.push([currentName(it), it, d || "current", money2(p)]); }
    cyc.push([d, tm, c.status, cStores, cItems.size, cc, cp, cu, exact(ck)]);
  }
  const NOW = numberMap(db.catalog);
  const owner = {}; for (const p of db.catalog.restockers || []) for (const it of p.items) if (!(it in owner)) owner[it] = p.name;
  const totalCost = cyc.reduce((a, r) => a + Number(r[8]), 0), totalCases = cyc.reduce((a, r) => a + r[5], 0);
  const label = year ? String(year) : "all-time";
  const out = [
    { name: "README.txt", text: [
      "Restock Counter - full export", `Made: ${new Date().toString()}`, `App version: ${APP_VERSION}`, `Period: ${year ? "cycles cleared in " + year : "all time"} (plus the current, not yet cleared cycle${year && year !== thisYear ? " - not included for past years" : ""})`, "",
      `Cycles: ${cyc.length}   Order lines: ${lines.length}   Total cases: ${totalCases}   Total cost (priced lines): $${money2(totalCost)}`, "",
      "Files (CSV, open in Excel, Numbers or Google Sheets):",
      "  order-lines.csv        every line of every order: date, store, item number, item, section, person, cases, cost per case, line cost",
      "                         'Current name' is filled in when the item has been renamed since; 'Store asked for' when a manager changed the quantity",
      "  cycles.csv             one row per cycle: stores, items, cases (priced / unpriced) and cost",
      "  store-by-cycle.csv     one row per store per cycle",
      "  store-totals.csv       totals per store for the period",
      "  item-totals.csv        totals per item for the period (renamed items under their current name)",
      "  price-history.csv      the cost per case each item had in each cycle",
      "  items-current.csv      today's item list with numbers, sections, people, cost per case and whether it has a photo",
      "  stores-current.csv     today's stores and what each has submitted in the current cycle",
      "  people-current.csv     today's people and the items each is responsible for",
      "  setup-changes.csv      every recorded change to items, people and stores", "",
      "Costs use the price saved with each cycle, so past cycles keep the prices they had. Lines with no price have an empty cost.",
      "All costs are exact, not rounded (a half case can give a third decimal, e.g. 2.5 x $12.35 = $30.875), so any column you add up matches the app's totals. Format the columns as currency in your spreadsheet.",
      "A full backup (to restore the app) is a separate file: Manager > Settings > Backup > Download backup."].join("\r\n") + "\r\n" },
    { name: "order-lines.csv", text: csvText(["Cycle date", "Cycle time", "Status", "Store", "Item No. (then)", "Item", "Current name", "Section", "Person", "Cases", "Cost per case", "Line cost", "Store asked for"], lines) },
    { name: "cycles.csv", text: csvText(["Cycle date", "Cycle time", "Status", "Stores", "Items", "Cases", "Priced cases", "Unpriced cases", "Cost"], cyc) },
    { name: "store-by-cycle.csv", text: csvText(["Cycle date", "Status", "Store", "Items", "Cases", "Cost"], byStoreCycle) },
    { name: "store-totals.csv", text: csvText(["Store", "Cycles ordered", "Cases", "Cost", "First order", "Last order"], Object.entries(stores).sort((a, b) => b[1].cost - a[1].cost).map(([s, S]) => [s, S.cycles, S.cases, exact(S.cost), S.first || "", S.last || ""])) },
    { name: "item-totals.csv", text: csvText(["Item No. (now)", "Item", "Section", "Cycles ordered", "Cases", "Cost", "Average cost per case"], Object.entries(items).sort((a, b) => b[1].cost - a[1].cost).map(([it, I]) => [NOW[it] || "", it, I.sec, I.cycles.size, I.cases, exact(I.cost), I.priced ? money2(I.cost / I.priced) : ""])) },
    { name: "price-history.csv", text: csvText(["Item", "Name then", "Cycle date", "Cost per case"], priceRows) },
    { name: "items-current.csv", text: csvText(["Item No.", "Item", "Section", "Person", "Cost per case", "Has photo"], db.catalog.categories.flatMap(c => c.items.map(it => [NOW[it], it, c.name, owner[it] || "", Number(db.prices[it]) > 0 ? money2(Number(db.prices[it])) : "", photos[it] ? "yes" : "no"]))) },
    { name: "stores-current.csv", text: csvText(["Store", "Submitted this cycle", "Cases this cycle", "Last submitted"], db.catalog.stores.map(s => { const r = db.restocks[slug(s)]; const n = r ? Object.values(r.counts || {}).reduce((a, v) => a + Number(v || 0), 0) : 0; return [s, r ? "yes" : "no", n, r && r.updatedAt ? r.updatedAt : ""]; })) },
    { name: "people-current.csv", text: csvText(["Person", "Items", "Item list"], (db.catalog.restockers || []).map(p => [p.name, p.items.length, p.items.join("; ")])) },
    { name: "setup-changes.csv", text: csvText(["Date", "Kind", "Change"], logFiles().map(f => readSetupLog(f.replace(/\.json$/, ""))).filter(Boolean).flatMap(e => ((e.changes || []).length ? e.changes : [{ k: e.kind === "baseline" ? "Starting point" : e.kind }]).map(c => [e.at, e.kind, describeChange(c)]))) },
  ];
  return { zip: makeZip(out), label };
}
function sendFile(res, buf, type, filename) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" });
  res.end(buf);
}

/* ---------- static files ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json"
};
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------- API ---------- */
async function handleApi(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // POST /api/photo?item=<name>[&replace=1]   body: the image (JPEG/PNG/WebP). Open to everyone.
  if (req.method === "POST" && parts[1] === "photo") {
    const want = (url.searchParams.get("item") || "").trim();
    const items = new Map();
    for (const c of db.catalog.categories) for (const it of c.items) if (!items.has(normKey(it))) items.set(normKey(it), it);
    const item = items.get(normKey(want));
    // too big by its own declared size: answer straight away without reading it
    if (Number(req.headers["content-length"]) > MAX_PHOTO_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
      return res.end(JSON.stringify({ error: "photo too large" }), () => req.destroy());
    }
    const early = async (code, obj) => { try { await readRaw(req, MAX_PHOTO_BYTES); } catch (e) {} return sendJson(res, code, obj); };
    if (!item) return early(404, { error: "that item isn't in the list" });
    if (photos[item] && url.searchParams.get("replace") !== "1") return early(409, { error: "already has a photo", exists: true });
    const ip = req.socket.remoteAddress || "?";
    if (!uploadAllowed(ip)) return early(429, { error: "too many photos at once, try again in a few minutes" });
    let buf;
    try { buf = await readRaw(req, MAX_PHOTO_BYTES); } catch (e) { return sendJson(res, 413, { error: e.message }); }
    const type = imageType(buf);
    if (!type) return sendJson(res, 400, { error: "that isn't a photo the app can use (JPEG, PNG or WebP)" });
    const file = require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 24) + type.ext;
    const old = photos[item] && photos[item].file;
    try {
      fs.mkdirSync(PHOTO_DIR, { recursive: true });
      const dest = path.join(PHOTO_DIR, file);
      if (!fs.existsSync(dest)) { fs.writeFileSync(dest + ".tmp", buf); fs.renameSync(dest + ".tmp", dest); }
      photos[item] = { file, at: new Date().toISOString(), bytes: buf.length };
      savePhotos();
    } catch (e) {
      console.error("Photo save failed:", e.message);
      return sendJson(res, 500, { error: "couldn't save the photo" });
    }
    if (old && old !== file) dropPhotoFileIfUnused(old);
    return sendJson(res, 200, { ok: true, item, url: "/photos/" + file, replaced: !!old });
  }

  // DELETE /api/photo?item=<name>   (open to everyone)
  if (req.method === "DELETE" && parts[1] === "photo") {
    const want = normKey(url.searchParams.get("item") || "");
    const key = Object.keys(photos).find(k => normKey(k) === want);
    if (!key) return sendJson(res, 200, { ok: true, unchanged: true });
    const old = photos[key].file;
    delete photos[key];
    try { savePhotos(); } catch (e) { return sendJson(res, 500, { error: "couldn't remove the photo" }); }
    dropPhotoFileIfUnused(old);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/state  -> everything the app needs
  if (req.method === "GET" && parts[1] === "state") {
    return sendJson(res, 200, { version: APP_VERSION, catalog: db.catalog, restocks: db.restocks, prices: db.prices || {}, photos: photoUrls(), pinRequired: !!ADMIN_PIN });
  }

  // PUT /api/restock/<storeSlug>  body: { store, counts, base? }
  // `base` is what the store's screen showed when it was opened. With it, only the items the
  // employee actually changed are taken from `counts`; everything else keeps the server's value,
  // so a manager's change made in the meantime is not silently undone. Without `base` (an older
  // page still open somewhere) the whole order is replaced, as before.
  if (req.method === "PUT" && parts[1] === "restock" && parts[2]) {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const store = typeof body.store === "string" ? body.store.trim().slice(0, 120) : "";
    if (!store) return sendJson(res, 400, { error: "store name required" });
    const clean = obj => {
      const out = {};
      if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
        const n = qtyOf(v);
        if (n > 0) out[String(k).slice(0, 120)] = n;
      }
      return out;
    };
    const counts = clean(body.counts);
    const prev = db.restocks[slug(store)];
    let final = counts, adj = {};
    if (prev && body.base && typeof body.base === "object") {
      const base = clean(body.base);
      final = Object.assign({}, prev.counts || {});
      adj = Object.assign({}, prev.adj || {});
      for (const k of new Set([...Object.keys(base), ...Object.keys(counts)])) {
        if ((counts[k] || 0) === (base[k] || 0)) continue;       // not touched on this screen: keep the server's value
        if (counts[k]) final[k] = counts[k]; else delete final[k];
        delete adj[k];                                         // the store's new ask replaces any earlier manager change
      }
    }
    const entry = { store, counts: final, updatedAt: new Date().toISOString() };
    if (Object.keys(adj).length) entry.adj = adj;
    db.restocks[slug(store)] = entry;
    saveDb();
    return sendJson(res, 200, { ok: true, counts: final, adj: entry.adj || {} });
  }

  // PUT /api/adjust  body: { item, counts: { "<store name>": cases } }   (PIN-protected if set)
  // A manager changes how much of ONE item each store gets, without opening each store's page.
  // The store's original ask is remembered in `adj` so it can be shown next to the new number.
  if (req.method === "PUT" && parts[1] === "adjust") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const want = typeof body.item === "string" ? body.item.trim() : "";
    let item = null;
    for (const c of db.catalog.categories) for (const it of c.items) if (!item && normKey(it) === normKey(want)) item = it;
    if (!item) for (const r of Object.values(db.restocks)) for (const k of Object.keys(r.counts || {})) if (!item && normKey(k) === normKey(want)) item = k;
    if (!item) return sendJson(res, 404, { error: "that item isn't in the list" });
    if (!body.counts || typeof body.counts !== "object") return sendJson(res, 400, { error: "nothing to change" });
    const known = new Map();
    for (const st of db.catalog.stores) known.set(slug(st), st);
    for (const [k, r] of Object.entries(db.restocks)) if (!known.has(k)) known.set(k, r.store);
    const changes = [];
    for (const [storeName, v] of Object.entries(body.counts)) {
      const key = slug(String(storeName));
      if (!known.has(key)) return sendJson(res, 400, { error: `unknown store: ${storeName}` });
      changes.push([key, known.get(key), qtyOf(v)]);
    }
    const now = new Date().toISOString();
    let changed = 0;
    for (const [key, storeName, n] of changes) {
      const entry = db.restocks[key] || { store: storeName, counts: {}, updatedAt: now };
      const had = (entry.counts || {})[item] || 0;
      if (n === had) continue;
      entry.counts = Object.assign({}, entry.counts);
      entry.adj = Object.assign({}, entry.adj);
      if (!(item in entry.adj)) entry.adj[item] = had;          // remember what the store first asked for
      if (n > 0) entry.counts[item] = n; else delete entry.counts[item];
      if (entry.adj[item] === n) delete entry.adj[item];        // back to what they asked: nothing to show
      if (!Object.keys(entry.adj).length) delete entry.adj;
      entry.adjustedAt = now;
      db.restocks[key] = entry;
      changed++;
    }
    if (changed) saveDb();
    return sendJson(res, 200, { ok: true, item, changed, restocks: db.restocks });
  }

  // PUT /api/catalog  body: { categories?, restockers?, stores? }   (PIN-protected if set)
  // Works on a copy: nothing changes unless every part is valid AND the change has been logged.
  if (req.method === "PUT" && parts[1] === "catalog") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const next = setupOf(db.catalog);
    const touched = [];
    if (body.categories !== undefined) {
      if (!Array.isArray(body.categories) || body.categories.length === 0)
        return sendJson(res, 400, { error: "add at least one page" });
      if (body.categories.length > 30)
        return sendJson(res, 400, { error: "too many pages (30 max)" });
      const rawGroups = [];
      const cats = [];
      for (const c of body.categories) {
        if (!c || typeof c.name !== "string" || !Array.isArray(c.items)) continue;
        const name = c.name.trim().slice(0, 60);
        if (!name) continue;
        rawGroups.push({ label: name, items: c.items });
        cats.push({ name, items: cleanNames(c.items, 2000) });
      }
      if (cats.length === 0) return sendJson(res, 400, { error: "add at least one page" });
      if (!cats.some(c => c.items.length > 0)) return sendJson(res, 400, { error: "add at least one item" });
      const dupes = findDuplicates(rawGroups);
      if (dupes.length) return sendJson(res, 400, { error: dupeMessage("items", dupes), duplicates: dupes, area: "items" });
      next.categories = cats;
      touched.push("items");
    }
    if (body.restockers !== undefined) {
      if (!Array.isArray(body.restockers)) return sendJson(res, 400, { error: "bad restocker list" });
      if (body.restockers.length > 100) return sendJson(res, 400, { error: "too many people (100 max)" });
      const rawGroups = [];
      const people = [];
      for (const p of body.restockers) {
        if (!p || typeof p.name !== "string" || !Array.isArray(p.items)) continue;
        const name = p.name.trim().slice(0, 60);
        if (!name) continue;
        rawGroups.push({ label: name, items: p.items });
        people.push({ name, items: cleanNames(p.items, 2000) });
      }
      const sameName = duplicatePersonNames(people);
      if (sameName.length) return sendJson(res, 400, { error: "Two people have the same name: " + sameName.join(", "), personNames: sameName, area: "people" });
      const dupes = findDuplicates(rawGroups);
      if (dupes.length) return sendJson(res, 400, { error: dupeMessage("people", dupes), duplicates: dupes, area: "people" });
      next.restockers = people;
      touched.push("people");
    }
    if (body.stores !== undefined) {
      const stores = cleanNames(body.stores, 200);
      if (!stores || stores.length === 0) return sendJson(res, 400, { error: "store list is empty" });
      next.stores = stores;
      touched.push("stores");
    }
    // renames: the same item under a new name. People, saved costs and live counts follow it.
    const rp = planRenames(body.renames, next);
    if (rp.error) return sendJson(res, 400, { error: rp.error });
    const renames = rp.renames;
    let nextPrices = db.prices || {}, nextRestocks = db.restocks || {}, baseline = db.catalog;
    if (renames.length) {
      const c = cascadeRenames(next.restockers, nextPrices, nextRestocks, renames);
      if (body.restockers === undefined) next.restockers = c.people;   // unless this same save sets people itself
      nextPrices = c.prices; nextRestocks = c.restocks;
      baseline = renameInSetup(setupOf(db.catalog), renames);
      const dupes = newPeopleDuplicates(db.catalog.restockers || [], next.restockers);
      if (dupes.length) return sendJson(res, 400, { error: dupeMessage("people", dupes), duplicates: dupes, area: "people" });
    }
    const changes = renames.map(r => ({ area: "items", k: "itemRenamed", from: r.from, to: r.to })).concat(diffSetup(baseline, next));
    const moved = JSON.stringify(nextPrices) !== JSON.stringify(db.prices || {}) || JSON.stringify(nextRestocks) !== JSON.stringify(db.restocks || {});
    if (changes.length === 0 && !moved) return sendJson(res, 200, { ok: true, unchanged: true, catalog: db.catalog });
    try {
      writeSetupLog(touched.length === 1 ? touched[0] : "setup", changes, next);
    } catch (e) {
      console.error("Setup log failed, not saving:", e.message);
      return sendJson(res, 500, { error: "could not record this change in the setup log; nothing was changed" });
    }
    db.catalog = Object.assign(db.catalog, next);
    db.prices = nextPrices; db.restocks = nextRestocks;
    saveDb();
    renamePhotos(renames);
    if (renames.length) renameHistory = null;
    return sendJson(res, 200, { ok: true, catalog: db.catalog, renamed: renames.length });
  }

  // POST /api/fix-names  body: { renames:[{from,to}] }  (PIN-protected if set)
  // For counted/priced/assigned names that are no longer in the catalog (an item renamed the old way).
  if (req.method === "POST" && parts[1] === "fix-names") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const next = setupOf(db.catalog);
    const rp = planRenames(body.renames || [], next);
    if (rp.error) return sendJson(res, 400, { error: rp.error });
    if (!rp.renames.length) return sendJson(res, 200, { ok: true, unchanged: true });
    const c = cascadeRenames(next.restockers, db.prices || {}, db.restocks || {}, rp.renames);
    next.restockers = c.people;
    const dupes = newPeopleDuplicates(db.catalog.restockers || [], next.restockers);
    if (dupes.length) return sendJson(res, 400, { error: dupeMessage("people", dupes), duplicates: dupes, area: "people" });
    const changes = rp.renames.map(r => ({ area: "items", k: "itemRenamed", from: r.from, to: r.to })).concat(diffSetup(renameInSetup(setupOf(db.catalog), rp.renames), next));
    try { writeSetupLog("items", changes, next); }
    catch (e) { return sendJson(res, 500, { error: "could not record this change in the setup log; nothing was changed" }); }
    db.catalog = Object.assign(db.catalog, next);
    db.prices = c.prices; db.restocks = c.restocks;
    saveDb();
    renamePhotos(rp.renames);
    renameHistory = null;
    return sendJson(res, 200, { ok: true, renamed: rp.renames.length });
  }

  // POST /api/archive-fixes  body: { file, map:{ oldName: nameInThatCycleCatalog } }  (PIN-protected if set)
  // Replaces the whole set of matches for that one cycle; the archive file is not touched.
  if (req.method === "POST" && parts[1] === "archive-fixes") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const name = path.basename(String(body.file || ""));
    if (!/^[\w.\-]+\.json$/.test(name)) return sendJson(res, 400, { error: "bad name" });
    let raw;
    try { raw = readArchiveRaw(name); } catch (e) { return sendJson(res, 404, { error: "not found" }); }
    const setup = { categories: (raw.catalog && raw.catalog.categories) || [] };
    const pairs = Object.entries(body.map && typeof body.map === "object" ? body.map : {}).map(([from, to]) => ({ from, to }));
    const rp = planRenames(pairs, setup);
    if (rp.error) return sendJson(res, 400, { error: rp.error });
    const map = {};
    for (const r of rp.renames) map[r.from] = r.to;
    try {
      const fixes = loadFixes();
      if (Object.keys(map).length) fixes[name] = map; else delete fixes[name];
      saveFixes(fixes);
    } catch (e) { return sendJson(res, 500, { error: "could not save the match" }); }
    return sendJson(res, 200, { ok: true, nameMap: map });
  }

  // GET /api/setup-log  -> newest 100 entries (no full snapshots), newest first
  if (req.method === "GET" && parts[1] === "setup-log" && !parts[2]) {
    const files = logFiles();
    const newest = files.slice(-100).reverse();
    const entries = [];
    for (const f of newest) {
      const e = readSetupLog(f.replace(/\.json$/, ""));
      if (!e) continue;
      entries.push({ id: e.id, at: e.at, kind: e.kind, changes: e.changes || [], counts: e.counts || {}, from: e.from || null, scope: e.scope || null });
    }
    return sendJson(res, 200, { entries, total: files.length, currentId: entries.length ? entries[0].id : null, duplicates: catalogDuplicates(db.catalog) });
  }

  // GET /api/setup-log/<id>  -> what restoring this entry would change, area by area
  if (req.method === "GET" && parts[1] === "setup-log" && parts[2] && !parts[3]) {
    const e = readSetupLog(parts[2]);
    if (!e) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { id: e.id, at: e.at, kind: e.kind, counts: e.counts || {}, wouldChange: diffSetup(db.catalog, e.catalog), duplicates: catalogDuplicates(e.catalog) });
  }

  // POST /api/setup-log/<id>/restore  body: { scope: "all"|"items"|"people"|"stores" }  (PIN-protected if set)
  if (req.method === "POST" && parts[1] === "setup-log" && parts[2] && parts[3] === "restore") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const scope = body.scope || "all";
    if (!["all", "items", "people", "stores"].includes(scope)) return sendJson(res, 400, { error: "bad scope" });
    const e = readSetupLog(parts[2]);
    if (!e || !e.catalog) return sendJson(res, 404, { error: "not found" });
    const old = setupOf(e.catalog);
    const next = setupOf(db.catalog);
    if (scope === "all" || scope === "items") next.categories = old.categories;
    if (scope === "all" || scope === "people") next.restockers = old.restockers;
    if (scope === "all" || scope === "stores") next.stores = old.stores;
    const changes = diffSetup(db.catalog, next);
    if (changes.length === 0) return sendJson(res, 200, { ok: true, unchanged: true, catalog: db.catalog });
    try {
      writeSetupLog("restore", changes, next, { from: e.at, scope });
    } catch (err) {
      console.error("Setup log failed, not restoring:", err.message);
      return sendJson(res, 500, { error: "could not record the restore in the setup log; nothing was changed" });
    }
    db.catalog = Object.assign(db.catalog, next);
    saveDb();
    return sendJson(res, 200, { ok: true, catalog: db.catalog, duplicates: catalogDuplicates(db.catalog) });
  }

  // PUT /api/prices  body: { prices: { item: cost } }  -> merged in; no PIN (restockers log costs)
  if (req.method === "PUT" && parts[1] === "prices") {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.prices || typeof body.prices !== "object") return sendJson(res, 400, { error: "no prices given" });
    if (!db.prices) db.prices = {};
    for (const [k, v] of Object.entries(body.prices)) {
      const key = String(k).slice(0, 120);
      if (v === null || v === "") { delete db.prices[key]; continue; }
      const n = Number(v);
      if (!isFinite(n) || n < 0 || n > 1000000) continue;
      db.prices[key] = Math.round(n * 100) / 100;
    }
    saveDb();
    return sendJson(res, 200, { ok: true, prices: db.prices });
  }

  // GET /api/verify  -> is this PIN correct? used by the manager-view gate
  if (req.method === "GET" && parts[1] === "verify") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    return sendJson(res, 200, { ok: true });
  }

  // ---------- backup / restore / export (PIN-protected when a PIN is set) ----------
  // GET /api/backup-info -> when the last backup was downloaded, what is on the Pi now, safety copies
  if (req.method === "GET" && parts[1] === "backup-info") {
    const years = new Set();
    try { for (const f of fs.readdirSync(ARCHIVE_DIR).filter(n => JSON_NAME.test(n))) { try { const a = readArchiveRaw(f); if (a.clearedAt) years.add(new Date(a.clearedAt).getFullYear()); } catch (e) {} } } catch (e) {}
    return sendJson(res, 200, { lastBackup: backupMeta(), current: currentSummary(), safetyCopies: safetyCopies(), years: [...years].sort((a, b) => b - a) });
  }

  // GET /api/backup[?photos=0]  -> the whole app in one file
  if (req.method === "GET" && parts[1] === "backup" && !parts[2]) {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    const withPhotos = url.searchParams.get("photos") !== "0";
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="restock-backup-${stampNow()}.zip"`, "Cache-Control": "no-store" });
    try { const n = await zipToStream(res, backupEntries(withPhotos)); res.end(); noteBackup(n, withPhotos); }
    catch (e) { console.error("Backup failed:", e.message); res.destroy(); }
    return;
  }

  // GET /api/backup/safety/<name>  -> download a safety copy made before a restore
  if (req.method === "GET" && parts[1] === "backup" && parts[2] === "safety" && parts[3]) {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    const name = path.basename(decodeURIComponent(parts[3]));
    if (!/^[\w.\-]+\.zip$/.test(name)) return sendJson(res, 404, { error: "not found" });
    let buf; try { buf = fs.readFileSync(path.join(BACKUP_DIR, name)); } catch (e) { return sendJson(res, 404, { error: "not found" }); }
    return sendFile(res, buf, "application/zip", name);
  }

  // POST /api/restore?dry=1               body: a backup file -> what's in it (changes nothing)
  // POST /api/restore?confirm=RESTORE     body: a backup file -> replaces everything (safety copy first)
  if (req.method === "POST" && parts[1] === "restore") {
    if (!adminOk(req)) { req.resume(); return sendJson(res, 401, { error: "wrong PIN" }); }
    if (Number(req.headers["content-length"]) > MAX_RESTORE_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
      return res.end(JSON.stringify({ error: "file too large" }), () => req.destroy());
    }
    let buf;
    try { buf = await readRaw(req, MAX_RESTORE_BYTES); } catch (e) { return sendJson(res, 413, { error: "file too large" }); }
    const p = await parseBackup(buf);
    if (p.error) return sendJson(res, 400, { error: p.error });
    const summary = backupSummary(p.backup);
    if (url.searchParams.get("dry") === "1") return sendJson(res, 200, { ok: true, dry: true, summary, current: currentSummary() });
    if (url.searchParams.get("confirm") !== "RESTORE") return sendJson(res, 400, { error: "type RESTORE to confirm" });
    try {
      const safety = await applyRestore(p);
      console.log(`Restored the backup from ${summary.createdAt}; safety copy of the previous data: ${safety}`);
      return sendJson(res, 200, { ok: true, summary, safetyCopy: path.basename(safety) });
    } catch (e) {
      console.error("Restore failed:", e.message);
      return sendJson(res, 500, { error: "the restore failed and nothing was replaced: " + e.message });
    }
  }

  // GET /api/export[?year=2026]  -> ZIP of CSV files for records and taxes
  if (req.method === "GET" && parts[1] === "export") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    const y = Number(url.searchParams.get("year")) || null;
    try {
      const { zip, label } = buildExport(y);
      return sendFile(res, zip, "application/zip", `restock-export-${label}-${stampNow().slice(0, 10)}.zip`);
    } catch (e) { console.error("Export failed:", e.message); return sendJson(res, 500, { error: "couldn't make the export" }); }
  }

  // GET /api/stats-data  -> every saved cycle, compact, oldest first (for the History reports)
  if (req.method === "GET" && parts[1] === "stats-data") return sendJson(res, 200, statsData());

  // GET /api/archives  -> list past cycles (newest first)
  if (req.method === "GET" && parts[1] === "archives" && !parts[2]) {
    let files = [];
    try { files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json")); } catch (e) {}
    const out = [];
    for (const f of files) {
      try {
        const a = loadArchive(f);
        let cases = 0, cost = 0;
        const totals = {};
        for (const s of Object.values(a.restocks || {}))
          for (const [it, n] of Object.entries(s.counts || {})) {
            totals[it] = (totals[it] || 0) + n;
            cases += n;
          }
        for (const [it, n] of Object.entries(totals)) {
          const u = Number((a.prices || {})[it]);
          if (isFinite(u) && u > 0) cost += u * n;
        }
        out.push({
          file: f,
          clearedAt: a.clearedAt || null,
          stores: Object.keys(a.restocks || {}).length,
          items: Object.keys(totals).length,
          cases: Math.round(cases * 2) / 2,
          cost: Math.round(cost * 100) / 100
        });
      } catch (e) { /* skip unreadable archive */ }
    }
    out.sort((a, b) => String(b.clearedAt).localeCompare(String(a.clearedAt)));
    return sendJson(res, 200, { archives: out });
  }

  // GET /api/archives/<file>  -> one past cycle in full
  if (req.method === "GET" && parts[1] === "archives" && parts[2]) {
    const name = path.basename(parts[2]);
    if (!/^[\w.\-]+\.json$/.test(name)) return sendJson(res, 400, { error: "bad name" });
    try {
      return sendJson(res, 200, loadArchive(name));
    } catch (e) { return sendJson(res, 404, { error: "not found" }); }
  }

  /* The DELETE /api/archives/<file> endpoint was removed in v3.17.
     Archived cycles are the only record of a completed order, and a single
     mis-tap in History destroyed one permanently. Cycles can now only be
     removed by deleting the file on the server, deliberately. */

  // DELETE /api/restocks  -> archive this cycle, then clear counts   (PIN-protected if set)
  if (req.method === "DELETE" && parts[1] === "restocks") {
    if (!adminOk(req)) return sendJson(res, 401, { error: "wrong PIN" });
    const hadCounts = Object.keys(db.restocks || {}).length > 0;
    if (hadCounts) {
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        const now = new Date();
        const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const snapshot = {
          clearedAt: now.toISOString(),
          restocks: db.restocks,
          prices: db.prices || {},
          catalog: db.catalog
        };
        // never overwrite an existing archive, even if two clears land in the same second
        let file = path.join(ARCHIVE_DIR, `cycle-${stamp}.json`);
        let n = 2;
        while (fs.existsSync(file)) file = path.join(ARCHIVE_DIR, `cycle-${stamp}-${n++}.json`);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
      } catch (e) {
        console.error("Archive failed, not clearing:", e.message);
        return sendJson(res, 500, { error: "could not archive this cycle; nothing was cleared" });
      }
    }
    db.restocks = {};
    saveDb();
    return sendJson(res, 200, { ok: true, archived: hadCounts });
  }

  sendJson(res, 404, { error: "not found" });
}

/* ---------- server ---------- */
loadDb();
loadPhotos();
ensureLogBaseline();
http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch(e => sendJson(res, 500, { error: "server error" }));
  } else if (req.method === "GET" && req.url.startsWith("/photos/")) {
    servePhoto(req, res);
  } else if (req.method === "GET") {
    serveStatic(req, res);
  } else {
    res.writeHead(405); res.end();
  }
}).listen(PORT, () => {
  console.log(`Restock Counter ${APP_VERSION} running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === "IPv4" && !n.internal) console.log(`  Network: http://${n.address}:${PORT}   <- use this on phones`);
  }
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Setup log: ${logFiles().length} entries in ${SETUP_LOG_DIR}`);
  console.log(`  Photos: ${Object.keys(photos).length} items have a photo (${PHOTO_DIR})`);
  if (ADMIN_PIN) console.log(`  Manager PIN is ON`);
  else console.log(`  Manager PIN is OFF (set ADMIN_PIN=1234 to protect the Manager view)`);
});
