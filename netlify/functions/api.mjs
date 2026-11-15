// EDU Air Control – backend (Netlify Function v2 + Netlify Blobs)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/* ------------------------------------------------------------------ */
/*  Flygplatser (servern är sanningskälla för banor)                   */
/* ------------------------------------------------------------------ */
export const AIRPORTS = [
  {
    id: "katrineholm-kattport",
    name: "Katrineholm Kattport International Airport",
    runways: ["1A", "2A", "3A", "4A", "1B", "2B", "3B", "4B"],
    terminals: [
      { id: "T1", name: "Terminal 1", gates: ["1a", "2a", "3a", "4a", "5a", "6a"] },
      { id: "T2", name: "Terminal 2", gates: ["7b", "8b", "9b", "10b", "11b", "12b", "13b", "14b", "15b", "16b"] },
    ],
  },
  { id: "malmo", name: "Malmö International Airport", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["1"] }] },
  { id: "uk", name: "UK International Airport", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["2"] }] },
  { id: "hallonbergen", name: "Hallonbergen Airport", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["2", "3"] }] },
  { id: "katrineholm-halvon", name: "Katrineholm Halvön Airport", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["1"] }] },
  { id: "turkmenistan", name: "Turkmenistan Internationella Flygfält", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["1"] }] },
  { id: "borgvik", name: "Borgvik Airport", runways: ["1"], terminals: [{ id: "T1", name: "Terminal 1", gates: ["1"] }] },
];

/* Adminkonto. Kan bytas utan kodändring via miljövariablerna
   ADMIN_USERNAME och ADMIN_PASSWORD i Netlify. */
const adminUser = () => process.env.ADMIN_USERNAME || "Byggnadsnamden";
const adminPass = () => process.env.ADMIN_PASSWORD || "Nämden2026!";

const SESSION_MS = 7 * 24 * 3600 * 1000;
const PRESENCE_TTL = 90 * 1000; // ATC räknas som på plats i 90 s efter senaste aktivitet
const PENDING_TTL = 30 * 60 * 1000; // väntande förfrågan går ut efter 30 min
const APPROVED_TTL = 60 * 60 * 1000; // godkänt tillstånd avslutas automatiskt efter 60 min
const HISTORY_TTL = 48 * 3600 * 1000; // historik rensas efter 48 h
const ACTIVE = ["pending", "approved"];
const MESSAGE_TTL = 24 * 3600 * 1000; // ACARS-meddelanden rensas efter 24 h
const ENROUTE_TTL = 3 * 3600 * 1000; // "på väg" avslutas automatiskt efter 3 h
const ID_RE = /^[a-z0-9]+-[a-f0-9]{8}$/;
const EVENT_TTL = 48 * 3600 * 1000; // aktivitetsloggen sparas i 48 h
const EVENT_KEEP = 300; // och högst 300 händelser
const SEEN_ONLINE = 90 * 1000; // räknas som online 90 s efter senaste aktivitet
const ANN_TTL = 7 * 24 * 3600 * 1000; // information på startsidan försvinner efter 7 dygn
const GATE_TTL = 6 * 3600 * 1000; // en tilldelad gate släpps automatiskt efter 6 h
const EMERGENCY_TTL = 3 * 3600 * 1000; // ett nödläge avslutas automatiskt efter 3 h
const TYPE_SV = { landing: "landning", takeoff: "start" };
const WEATHER = { clear: "Klart", cloudy: "Molnigt", rain: "Regn", thunder: "Åska", snow: "Snö", fog: "Dimma", storm: "Storm" };
const TIMEOFDAY = { dawn: "Gryning", day: "Dag", dusk: "Skymning", night: "Natt" };
const EMERGENCY_KINDS = { engine: "Motorproblem", fire: "Brand ombord", fuel: "Bränslebrist", medical: "Sjukdom ombord", gear: "Landningsställ", other: "Annat" };
const short = (s, n = 80) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
const FLIGHT_RE = /^[A-Z0-9][A-Z0-9 \-]{1,11}$/;
const AIRLINE_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'\-]{1,39}$/u;
const DEST_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'\-]{1,59}$/u; // längre än flygbolag: flygplatsnamnen är upp till 42 tecken

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/* ------------------------------------------------------------------ */
/*  Hjälpfunktioner                                                    */
/* ------------------------------------------------------------------ */
async function hashPw(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const buf = await scrypt(pw, salt, 64);
  return { salt, hash: buf.toString("hex") };
}
async function verifyPw(pw, salt, hash) {
  const buf = await scrypt(pw, salt, 64);
  const exp = Buffer.from(hash, "hex");
  return buf.length === exp.length && crypto.timingSafeEqual(buf, exp);
}
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

async function readBody(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw bad("Ogiltig JSON.");
  }
}

const publicUser = (u) => ({
  username: u.username,
  role: u.role,
  status: u.status,
  flightNumber: u.flightNumber || "",
  airline: u.airline || "",
  destination: u.destination || "",
  airport: u.airport || null,
  createdAt: u.createdAt || null,
});

const findAirport = (id) => AIRPORTS.find((a) => a.id === id);

/* Flygplatsstatus: stängning, stängda banor och information */
const emptyStatus = () => ({ closed: false, reason: "", closedBy: null, closedAt: null, runways: {}, notices: [], weather: null, tod: null });
async function getStatus(db, id) {
  return { ...emptyStatus(), ...((await db.airportstatus.get(id, { type: "json" })) || {}) };
}
async function loadStatuses(db) {
  const rows = await Promise.all(AIRPORTS.map((a) => getStatus(db, a.id)));
  return Object.fromEntries(AIRPORTS.map((a, i) => [a.id, rows[i]]));
}
const closedMsg = (what, reason) => `${what} är stängd${reason ? ": " + reason : "."}`;

/* ------------------------------------------------------------------ */
/*  Inloggning och sessioner                                           */
/* ------------------------------------------------------------------ */
async function newSession(db, user) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.sessions.setJSON(sha(token), {
    username: user.username,
    role: user.role,
    expires: Date.now() + SESSION_MS,
  });
  return json({ token, user: publicUser(user) });
}

async function authenticate(req, db) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const sessionKey = sha(token);
  const s = await db.sessions.get(sessionKey, { type: "json" });
  if (!s) return null;
  if (s.expires < Date.now()) {
    await db.sessions.delete(sessionKey);
    return null;
  }
  if (s.role === "admin") {
    return { sessionKey, me: { username: adminUser(), role: "admin", status: "approved" } };
  }
  const u = await db.users.get(s.username.toLowerCase(), { type: "json" });
  if (!u || u.status !== "approved") return null;
  return { sessionKey, me: u };
}

async function checkThrottle(db, key) {
  const t = await db.throttle.get(key, { type: "json" });
  if (t && t.until && t.until > Date.now()) {
    throw new HttpError(429, "För många felaktiga inloggningar. Vänta några minuter och försök igen.");
  }
}
async function failLogin(db, key) {
  const now = Date.now();
  let t = (await db.throttle.get(key, { type: "json" })) || { count: 0, first: now };
  if (now - t.first > 10 * 60 * 1000) t = { count: 0, first: now };
  t.count += 1;
  if (t.count >= 8) t.until = now + 10 * 60 * 1000;
  await db.throttle.setJSON(key, t);
}

async function register(req, db) {
  const { username, password, role } = await readBody(req);
  if (typeof username !== "string" || !MC_NAME.test(username))
    throw bad("Ogiltigt Minecraft-användarnamn (3–16 tecken: A–Z, 0–9 och _).");
  if (typeof password !== "string" || password.length < 6 || password.length > 100)
    throw bad("Lösenordet måste vara minst 6 tecken.");
  if (role !== "pilot" && role !== "atc") throw bad("Välj kontotyp: Pilot eller ATC.");

  const lc = username.toLowerCase();
  if (lc === adminUser().toLowerCase()) throw new HttpError(409, "Användarnamnet är redan registrerat.");
  const existing = await db.users.get(lc, { type: "json" });
  if (existing && existing.status !== "rejected")
    throw new HttpError(409, "Användarnamnet är redan registrerat.");

  const { salt, hash } = await hashPw(password);
  await db.users.setJSON(lc, {
    username,
    role,
    status: "pending",
    salt,
    hash,
    createdAt: Date.now(),
    flightNumber: "",
    airline: "",
    airport: null,
  });
  return json({ ok: true, message: "Kontot är skapat! Det måste godkännas av admin innan du kan logga in." }, 201);
}

async function login(req, db) {
  const { username, password } = await readBody(req);
  if (typeof username !== "string" || typeof password !== "string" || !username || username.length > 64 || password.length > 200)
    throw new HttpError(401, "Fel användarnamn eller lösenord.");
  const lc = username.toLowerCase();
  await checkThrottle(db, lc);

  if (lc === adminUser().toLowerCase()) {
    if (safeEq(password, adminPass())) {
      await db.throttle.delete(lc);
      return newSession(db, { username: adminUser(), role: "admin", status: "approved" });
    }
    await failLogin(db, lc);
    throw new HttpError(401, "Fel användarnamn eller lösenord.");
  }

  const u = MC_NAME.test(username) ? await db.users.get(lc, { type: "json" }) : null;
  if (!u || !(await verifyPw(password, u.salt, u.hash))) {
    await failLogin(db, lc);
    throw new HttpError(401, "Fel användarnamn eller lösenord.");
  }
  if (u.status === "pending") throw new HttpError(403, "Ditt konto väntar fortfarande på godkännande av admin.");
  if (u.status === "rejected") throw new HttpError(403, "Ditt konto har nekats av admin.");
  await db.throttle.delete(lc);
  await touchSeen(db, u, { force: true });
  await logEvent(db, u, "loggade in");
  return newSession(db, u);
}

/* ------------------------------------------------------------------ */
/*  Aktivitetslogg och "senast aktiv" (visas för admin)                */
/* ------------------------------------------------------------------ */
async function logEvent(db, me, text, extra = {}) {
  try {
    const now = Date.now();
    const id = now.toString(36) + "-" + crypto.randomBytes(3).toString("hex");
    await db.activity.setJSON("e/" + id, { id, at: now, actor: me.username, role: me.role, text, ...extra });
  } catch (e) {
    console.error("logEvent", e); // loggen får aldrig stoppa den vanliga åtgärden
  }
}

async function loadEvents(db, limit = 150) {
  const now = Date.now();
  const { blobs } = await db.activity.list({ prefix: "e/" });
  // Nycklarna börjar med tidsstämpeln (base 36), så de går att sortera och rensa utan att läsa dem
  const keys = blobs.map((b) => b.key).sort().reverse();
  const keep = [];
  const drop = [];
  for (const k of keys) {
    const ts = parseInt(k.slice(2).split("-")[0], 36);
    if (!Number.isFinite(ts) || now - ts > EVENT_TTL || keep.length >= EVENT_KEEP) drop.push(k);
    else keep.push(k);
  }
  await Promise.all(drop.map((k) => db.activity.delete(k)));
  const rows = (await Promise.all(keep.slice(0, limit).map((k) => db.activity.get(k, { type: "json" })))).filter(Boolean);
  return rows.sort((a, b) => b.at - a.at);
}

async function touchSeen(db, me, { force = false, out = false } = {}) {
  if (me.role === "admin") return;
  const key = me.username.toLowerCase();
  const now = Date.now();
  if (!force) {
    const s = await db.seen.get(key, { type: "json" });
    if (s && !s.out && now - s.at < 30 * 1000) return; // skriv högst var 30:e sekund
  }
  await db.seen.setJSON(key, { username: me.username, role: me.role, at: now, out });
}

/* ------------------------------------------------------------------ */
/*  Förfrågningar och status                                           */
/* ------------------------------------------------------------------ */
async function loadRequests(db) {
  const now = Date.now();
  const { blobs } = await db.requests.list({ prefix: "r/" });
  const all = (await Promise.all(blobs.map((b) => db.requests.get(b.key, { type: "json" })))).filter(Boolean);
  const out = [];
  for (const r of all) {
    let changed = false;
    if (r.status === "pending" && now - r.createdAt > PENDING_TTL) {
      r.status = "expired";
      changed = true;
    } else if (r.status === "approved" && now - (r.approvedAt || r.updatedAt) > APPROVED_TTL) {
      r.status = "completed";
      changed = true;
    }
    if (changed) {
      r.updatedAt = now;
      await db.requests.setJSON("r/" + r.id, r);
    }
    if (!ACTIVE.includes(r.status) && now - (r.updatedAt || r.createdAt) > HISTORY_TTL) {
      await db.requests.delete("r/" + r.id);
      continue;
    }
    out.push(r);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function loadPresence(db) {
  const now = Date.now();
  const { blobs } = await db.presence.list();
  const rows = [];
  for (const b of blobs) {
    const p = await db.presence.get(b.key, { type: "json" });
    if (!p) continue;
    if (now - p.lastSeen > PRESENCE_TTL) {
      await db.presence.delete(b.key);
      continue;
    }
    rows.push(p);
  }
  return rows;
}

async function heartbeat(db, me) {
  if (me.role !== "atc" || !me.airport) return;
  const key = me.username.toLowerCase();
  const p = await db.presence.get(key, { type: "json" });
  if (!p || p.airport !== me.airport || Date.now() - p.lastSeen > 30 * 1000) {
    await db.presence.setJSON(key, { username: me.username, airport: me.airport, lastSeen: Date.now() });
  }
}

/* ---------------- Gater (tilldelas av ATC) ---------------- */
async function loadGates(db) {
  const now = Date.now();
  const { blobs } = await db.gates.list();
  const rows = [];
  for (const b of blobs) {
    const g = await db.gates.get(b.key, { type: "json" });
    if (!g) continue;
    if (now - g.at > GATE_TTL) {
      await db.gates.delete(b.key);
      continue;
    }
    rows.push(g);
  }
  return rows;
}

// Släpper en pilots gate, antingen vid en viss flygplats eller överallt
async function releasePilotGates(db, username, airportId = null) {
  const rows = await loadGates(db);
  for (const g of rows) if (g.pilot === username && (!airportId || g.airport === airportId)) await db.gates.delete(`${g.airport}/${g.gate}`);
}

// Piloter som en flygplats kan tilldela gate: de som har en förfrågan där, är på väg dit eller har skickat ACARS dit
function contactsFor(airportId, reqs, msgs, enroute) {
  const map = new Map();
  for (const r of reqs) if (r.airport === airportId) map.set(r.pilot, { username: r.pilot, flightNumber: r.flightNumber });
  for (const m of msgs) if (m.airport === airportId && m.fromRole === "pilot") map.set(m.from, { username: m.from, flightNumber: m.flightNumber });
  for (const f of enroute) if (f.airport === airportId) map.set(f.username, { username: f.username, flightNumber: f.flightNumber });
  return map;
}

function buildAirports(reqs, presence, statuses, gates = [], emergencies = []) {
  return AIRPORTS.map((a) => {
    const s = statuses[a.id] || emptyStatus();
    const mine = gates.filter((g) => g.airport === a.id);
    const terminals = a.terminals.map((t) => ({
      id: t.id,
      name: t.name,
      gates: t.gates.map((g) => {
        const o = mine.find((x) => x.gate === g);
        return { id: g, label: "Gate " + g, occupied: o ? { pilot: o.pilot, flightNumber: o.flightNumber, airline: o.airline, since: o.at } : null };
      }),
    }));
    const gatesTotal = terminals.reduce((n, t) => n + t.gates.length, 0);
    const gatesFree = terminals.reduce((n, t) => n + t.gates.filter((g) => !g.occupied).length, 0);
    const runwayStatus = Object.fromEntries(a.runways.map((rw) => [rw, null]));
    let pending = 0;
    for (const r of reqs) {
      if (r.airport !== a.id) continue;
      if (r.status === "approved" && r.runway in runwayStatus)
        runwayStatus[r.runway] = {
          requestId: r.id,
          flightNumber: r.flightNumber,
          airline: r.airline,
          destination: r.destination || "",
          type: r.type,
          pilot: r.pilot,
          since: r.approvedAt,
        };
      if (r.status === "pending") pending++;
    }
    return {
      id: a.id,
      name: a.name,
      runways: a.runways,
      runwayStatus,
      pending,
      atc: presence.filter((p) => p.airport === a.id).map((p) => p.username),
      terminals,
      gatesTotal,
      gatesFree,
      closed: !!s.closed,
      closedReason: s.reason || "",
      closedBy: s.closedBy || null,
      runwayClosed: Object.fromEntries(a.runways.map((rw) => [rw, s.runways[rw] || null])),
      notices: s.notices || [],
      weather: s.weather ? { kind: s.weather.kind, label: WEATHER[s.weather.kind], note: s.weather.note || "", by: s.weather.by, at: s.weather.at } : null,
      tod: s.tod ? { kind: s.tod.kind, label: TIMEOFDAY[s.tod.kind], by: s.tod.by, at: s.tod.at } : null,
      emergencies: emergencies.filter((e) => e.airport === a.id && e.status !== "resolved").length,
    };
  });
}

/* ---------------- ACARS ---------------- */
async function loadMessages(db) {
  const now = Date.now();
  const { blobs } = await db.messages.list({ prefix: "m/" });
  const all = (await Promise.all(blobs.map((b) => db.messages.get(b.key, { type: "json" })))).filter(Boolean);
  const out = [];
  for (const m of all) {
    if (now - m.createdAt > MESSAGE_TTL) {
      await db.messages.delete("m/" + m.id);
      continue;
    }
    out.push(m);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------------- Flyg på väg (ankommande flyg) ---------------- */
const resolveAirport = (text) => {
  const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? AIRPORTS.find((a) => a.id === t || a.name.toLowerCase() === t) || null : null;
};

async function loadEnroute(db) {
  const now = Date.now();
  const { blobs } = await db.enroute.list();
  const rows = [];
  for (const b of blobs) {
    const f = await db.enroute.get(b.key, { type: "json" });
    if (!f) continue;
    if (now - f.since > ENROUTE_TTL) {
      await db.enroute.delete(b.key);
      continue;
    }
    rows.push(f);
  }
  // Närmast ankomst först, flyg utan ETA sist
  return rows.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity) || a.since - b.since);
}

async function setEnroute(req, me, db) {
  if (me.role !== "pilot") throw new HttpError(403, "Endast piloter kan anmäla att de är på väg.");
  const { active, etaMinutes, landed } = await readBody(req);
  const key = me.username.toLowerCase();
  if (!active) {
    const had = await db.enroute.get(key, { type: "json" });
    await db.enroute.delete(key);
    let done = null;
    if (landed) {
      // "Jag har landat" är en lyckad landning: pilotens aktiva landningsförfrågan vid flygplatsen blir genomförd
      const mine = (await loadRequests(db)).find((r) => r.pilot === me.username && r.type === "landing" && ACTIVE.includes(r.status) && (!had || r.airport === had.airport));
      if (mine) done = await finishRequest(db, me, mine);
    }
    if (had && !done) await logEvent(db, me, `${landed ? "meddelade att hen har landat" : "avslutade sin flygning"} vid ${had.destination} (${had.flightNumber})`, { airport: had.airport });
    return json({ ok: true, request: done });
  }
  if (!me.flightNumber || !me.airline) throw bad("Registrera flygnummer och flygbolag först.");
  const ap = resolveAirport(me.destination);
  if (!ap) throw bad("Välj en av flygplatserna som destination under Ditt flyg och spara, så kan ATC se att du är på väg dit.");

  const now = Date.now();
  let eta = null;
  if (etaMinutes !== undefined && etaMinutes !== null && String(etaMinutes).trim() !== "") {
    const n = Number(String(etaMinutes).trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 1 || n > 180) throw bad("Beräknad ankomst ska vara mellan 1 och 180 minuter.");
    eta = now + Math.round(n * 60000);
  }
  const f = { username: me.username, flightNumber: me.flightNumber, airline: me.airline, destination: ap.name, airport: ap.id, since: now, eta };
  await db.enroute.setJSON(key, f);
  await logEvent(db, me, `anmälde sig på väg till ${ap.name} (${me.flightNumber})`, { airport: ap.id });
  return json({ flight: f }, 201);
}

// En pilot räknas som "vid" en flygplats om hen har en förfrågan där, är på väg dit eller har skrivit till/fått svar därifrån.
// För information på startsidan räknas även sparad destination.
function pilotAirports(me, { msgs = [], reqs = [], enroute = [], destination = false } = {}) {
  const set = new Set();
  for (const r of reqs) if (r.pilot === me.username) set.add(r.airport);
  for (const f of enroute) if (f.username === me.username) set.add(f.airport);
  for (const m of msgs) if (m.from === me.username || m.to === me.username) set.add(m.airport);
  if (destination) {
    const ap = resolveAirport(me.destination);
    if (ap) set.add(ap.id);
  }
  return set;
}

function visibleMessages(me, msgs, reqs, enroute = []) {
  if (me.role === "pilot") {
    const airports = pilotAirports(me, { msgs, reqs, enroute });
    return msgs.filter(
      (m) => m.from === me.username || m.to === me.username || m.scope === "all" || (m.scope === "airport" && airports.has(m.airport))
    );
  }
  if (me.role === "atc") return msgs.filter((m) => m.scope === "all" || (me.airport && m.airport === me.airport));
  return msgs; // admin ser allt
}

async function sendMessage(req, me, db) {
  if (me.role !== "pilot" && me.role !== "atc") throw new HttpError(403, "Endast piloter och ATC kan skicka ACARS.");
  const body = await readBody(req);
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  if (!text) throw bad("Skriv ett meddelande.");
  if (text.length > 200) throw bad("Meddelandet är för långt (max 200 tecken).");

  const msgs = await loadMessages(db);
  const now = Date.now();
  if (msgs.filter((m) => m.from === me.username && now - m.createdAt < 60000).length >= 8)
    throw new HttpError(429, "Du skickar för snabbt. Vänta en stund och försök igen.");

  let extra;
  if (me.role === "pilot") {
    const ap = findAirport(body.airport);
    if (!ap) throw bad("Välj vilken flygplats meddelandet gäller.");
    extra = { fromRole: "pilot", scope: "atc", flightNumber: me.flightNumber || "", airport: ap.id, to: null, toFlight: "" };
  } else {
    if (!me.airport) throw bad("Gå på tjänst vid en flygplats först.");
    if (body.to === "@airport" || body.to === "@all") {
      // Gruppmeddelande: till alla vid flygplatsen eller till alla piloter i hela systemet
      extra = { fromRole: "atc", scope: body.to === "@all" ? "all" : "airport", flightNumber: "", airport: me.airport, to: null, toFlight: "" };
    } else {
      const key = String(body.to || "").toLowerCase();
      if (!/^[a-z0-9_]{3,16}$/.test(key)) throw bad("Välj vem meddelandet går till.");
      const target = await db.users.get(key, { type: "json" });
      if (!target || target.role !== "pilot" || target.status !== "approved") throw bad("Piloten finns inte.");
      extra = { fromRole: "atc", scope: "pilot", flightNumber: "", airport: me.airport, to: target.username, toFlight: target.flightNumber || "" };
    }
  }
  const id = now.toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  const msg = { id, from: me.username, text, createdAt: now, ...extra };
  await db.messages.setJSON("m/" + id, msg);
  const apName = (findAirport(extra.airport) || {}).name || extra.airport;
  const target = extra.fromRole === "pilot" ? "ATC vid " + apName : extra.scope === "all" ? "alla piloter" : extra.scope === "airport" ? "alla vid " + apName : extra.to;
  await logEvent(db, me, `skickade ACARS till ${target}: "${short(text)}"`, { airport: extra.airport });
  return json({ message: msg }, 201);
}

/* ---------------- Information på startsidan (admin och ATC) ---------------- */
const ANN_AUDIENCES = { admin: ["all", "pilots", "atc"], atc: ["airport", "pilots"] };

async function loadAnnouncements(db) {
  const now = Date.now();
  const { blobs } = await db.announcements.list({ prefix: "n/" });
  const all = (await Promise.all(blobs.map((b) => db.announcements.get(b.key, { type: "json" })))).filter(Boolean);
  const out = [];
  for (const n of all) {
    if (now - n.createdAt > ANN_TTL) {
      await db.announcements.delete("n/" + n.id);
      continue;
    }
    out.push(n);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function visibleAnnouncements(me, anns, airports) {
  if (me.role === "admin") return anns;
  if (me.role === "atc") return anns.filter((n) => n.from === me.username || n.audience === "all" || n.audience === "atc");
  return anns.filter((n) => n.audience === "all" || n.audience === "pilots" || (n.audience === "airport" && airports.has(n.airport)));
}

async function createAnnouncement(req, me, db) {
  if (me.role !== "admin" && me.role !== "atc") throw new HttpError(403, "Endast admin och ATC kan lägga ut information.");
  const { audience, text: raw } = await readBody(req);
  if (!ANN_AUDIENCES[me.role].includes(audience)) throw bad("Välj vem informationen ska visas för.");
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) throw bad("Skriv en information.");
  if (text.length > 300) throw bad("Informationen är för lång (max 300 tecken).");
  if (me.role === "atc" && !me.airport) throw bad("Gå på tjänst vid en flygplats först.");

  const mine = (await loadAnnouncements(db)).filter((n) => n.from === me.username);
  const now = Date.now();
  if (mine.filter((n) => now - n.createdAt < 60000).length >= 5) throw new HttpError(429, "Du lägger ut information för snabbt. Vänta en stund.");
  if (mine.length >= 10) throw bad("Du har redan 10 aktiva informationer. Ta bort någon först.");

  const id = now.toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  const n = { id, from: me.username, fromRole: me.role, audience, airport: me.role === "atc" ? me.airport : null, text, createdAt: now };
  await db.announcements.setJSON("n/" + id, n);
  const who = { all: "alla", pilots: "alla piloter", atc: "alla ATC", airport: "piloter vid " + ((findAirport(n.airport) || {}).name || n.airport) }[audience];
  await logEvent(db, me, `lade ut information till ${who}: "${short(text)}"`, { airport: n.airport });
  return json({ announcement: n }, 201);
}

async function deleteAnnouncement(me, db, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, "Informationen hittades inte.");
  const n = await db.announcements.get("n/" + id, { type: "json" });
  if (!n) throw new HttpError(404, "Informationen hittades inte.");
  const allowed = me.role === "admin" || (me.role === "atc" && n.from === me.username);
  if (!allowed) throw new HttpError(403, "Du kan bara ta bort din egen information.");
  await db.announcements.delete("n/" + id);
  await logEvent(db, me, `tog bort information: "${short(n.text, 60)}"`, { airport: n.airport });
  return json({ ok: true });
}

async function state(me, db) {
  await heartbeat(db, me);
  await touchSeen(db, me);
  const [reqs, presence, msgs, statuses, enroute, anns, gates, emergs] = await Promise.all([loadRequests(db), loadPresence(db), loadMessages(db), loadStatuses(db), loadEnroute(db), loadAnnouncements(db), loadGates(db), loadEmergencies(db)]);
  let visible = [];
  if (me.role === "pilot") visible = reqs.filter((r) => r.pilot === me.username).slice(0, 25);
  else if (me.role === "atc" && me.airport) visible = reqs.filter((r) => r.airport === me.airport).slice(0, 80);
  else if (me.role === "admin") visible = reqs.slice(0, 100);

  // Piloter som ATC kan skriva till: de som har förfrågningar eller meddelanden vid flygplatsen
  let contacts = [];
  if (me.role === "atc" && me.airport) {
    contacts = [...contactsFor(me.airport, reqs, msgs, enroute).values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  // Pilotens egen gate
  let myGate = null;
  if (me.role === "pilot") {
    const g = gates.find((x) => x.pilot === me.username);
    if (g) myGate = { airport: g.airport, terminal: g.terminal, terminalName: g.terminalName, gate: g.gate, since: g.at };
  }

  // Ankommande flyg: ATC ser flyg på väg till sin flygplats, admin ser alla, piloten ser sitt eget
  let inbound = [];
  let myFlight = null;
  const withRequest = (f) => {
    const q = reqs.find((r) => r.pilot === f.username && r.airport === f.airport && ACTIVE.includes(r.status));
    return { ...f, request: q ? { status: q.status, type: q.type, runway: q.runway } : null };
  };
  if (me.role === "atc" && me.airport) inbound = enroute.filter((f) => f.airport === me.airport).map(withRequest);
  else if (me.role === "admin") inbound = enroute.map(withRequest);
  else if (me.role === "pilot") myFlight = enroute.find((f) => f.username === me.username) || null;

  return json({
    me: publicUser(me),
    airports: buildAirports(reqs, presence, statuses, gates, emergs),
    requests: visible,
    messages: visibleMessages(me, msgs, reqs, enroute).slice(0, 60),
    contacts,
    inbound,
    myFlight,
    myGate,
    emergencies: visibleEmergencies(me, emergs),
    announcements: visibleAnnouncements(me, anns, me.role === "pilot" ? pilotAirports(me, { msgs, reqs, enroute, destination: true }) : new Set()).slice(0, 30),
    now: Date.now(),
  });
}

async function profile(req, me, db) {
  const body = await readBody(req);
  const key = me.username.toLowerCase();
  const u = await db.users.get(key, { type: "json" });
  if (!u) throw new HttpError(404, "Kontot finns inte.");

  if (me.role === "pilot") {
    const flightNumber = String(body.flightNumber || "").trim().toUpperCase();
    const airline = String(body.airline || "").trim();
    if (!FLIGHT_RE.test(flightNumber)) throw bad("Ogiltigt flygnummer (2–12 tecken: A–Z, 0–9, mellanslag eller bindestreck).");
    if (!AIRLINE_RE.test(airline)) throw bad("Ogiltigt flygbolag (2–40 tecken).");
    const destination = String(body.destination || "").replace(/\s+/g, " ").trim();
    if (destination && !DEST_RE.test(destination)) throw bad("Ogiltig destination (2–60 tecken).");
    // Ändrad destination eller ändrat flygnummer gör att en pågående anmälan inte stämmer längre
    if (destination !== (u.destination || "") || flightNumber !== (u.flightNumber || "")) await db.enroute.delete(key);
    u.flightNumber = flightNumber;
    u.airline = airline;
    u.destination = destination;
    await db.users.setJSON(key, u);
    await logEvent(db, me, `uppdaterade sitt flyg: ${flightNumber}, ${airline}${destination ? ", destination " + destination : ""}`);
    return json({ me: publicUser(u) });
  }

  if (me.role === "atc") {
    const airport = body.airport || null;
    if (airport !== null && !findAirport(airport)) throw bad("Okänd flygplats.");
    const before = u.airport || null;
    u.airport = airport;
    await db.users.setJSON(key, u);
    if (airport) await db.presence.setJSON(key, { username: u.username, airport, lastSeen: Date.now() });
    else await db.presence.delete(key);
    if (airport !== before) {
      const name = airport ? findAirport(airport).name : null;
      await logEvent(db, me, airport ? `gick på tjänst vid ${name}` : "gick av tjänst", { airport: airport || before });
    }
    return json({ me: publicUser(u) });
  }
  throw bad("Kontot har ingen profil att spara.");
}

async function createRequest(req, me, db) {
  if (me.role !== "pilot") throw new HttpError(403, "Endast piloter kan begära tillstånd.");
  if (!me.flightNumber || !me.airline) throw bad("Registrera flygnummer och flygbolag först.");
  const { airport, runway, type } = await readBody(req);
  const ap = findAirport(airport);
  if (!ap) throw bad("Välj en flygplats.");
  if (!ap.runways.includes(runway)) throw bad("Banan finns inte på den flygplatsen.");
  if (type !== "landing" && type !== "takeoff") throw bad("Välj landning eller start.");

  const st = await getStatus(db, ap.id);
  if (st.closed) throw new HttpError(409, closedMsg("Flygplatsen", st.reason));
  if (st.runways[runway]) throw new HttpError(409, closedMsg(`Bana ${runway}`, st.runways[runway].reason));

  const reqs = await loadRequests(db);
  if (reqs.some((r) => r.pilot === me.username && ACTIVE.includes(r.status)))
    throw new HttpError(409, "Du har redan en aktiv förfrågan. Avbryt den först.");

  const now = Date.now();
  const id = now.toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  const r = {
    id,
    pilot: me.username,
    flightNumber: me.flightNumber,
    airline: me.airline,
    destination: me.destination || "",
    airport: ap.id,
    runway,
    type,
    status: "pending",
    note: "",
    decidedBy: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };
  await db.requests.setJSON("r/" + id, r);
  await logEvent(db, me, `begärde ${TYPE_SV[type]} på bana ${runway} vid ${ap.name} (${me.flightNumber})`, { airport: ap.id });
  return json({ request: r }, 201);
}

async function getRequest(db, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, "Förfrågan hittades inte.");
  const r = await db.requests.get("r/" + id, { type: "json" });
  if (!r) throw new HttpError(404, "Förfrågan hittades inte.");
  return r;
}

async function decide(req, me, db, id) {
  const r = await getRequest(db, id);
  const { action, note } = await readBody(req);
  const allowed = me.role === "admin" || (me.role === "atc" && me.airport === r.airport);
  if (!allowed) throw new HttpError(403, "Du är inte på tjänst vid den här flygplatsen.");

  const now = Date.now();
  if (action === "approve") {
    if (r.status !== "pending") throw new HttpError(409, "Förfrågan är inte längre väntande.");
    const st = await getStatus(db, r.airport);
    if (st.closed) throw new HttpError(409, closedMsg("Flygplatsen", st.reason) + " Öppna den innan du godkänner.");
    if (st.runways[r.runway]) throw new HttpError(409, closedMsg(`Bana ${r.runway}`, st.runways[r.runway].reason) + " Öppna den innan du godkänner.");
    const reqs = await loadRequests(db);
    if (reqs.some((x) => x.id !== r.id && x.airport === r.airport && x.runway === r.runway && x.status === "approved"))
      throw new HttpError(409, `Bana ${r.runway} är upptagen. Avsluta pågående tillstånd först.`);
    r.status = "approved";
    r.approvedAt = now;
  } else if (action === "deny") {
    if (!ACTIVE.includes(r.status)) throw new HttpError(409, "Förfrågan är redan avslutad.");
    r.status = "denied";
  } else if (action === "complete") {
    if (r.status !== "approved") throw new HttpError(409, "Endast godkända tillstånd kan avslutas.");
    r.status = "completed";
    // En genomförd landning avslutar pilotens "på väg" till den flygplatsen
    if (r.type === "landing") {
      const f = await db.enroute.get(r.pilot.toLowerCase(), { type: "json" });
      if (f && f.airport === r.airport) await db.enroute.delete(r.pilot.toLowerCase());
    }
    // En genomförd start betyder att piloten har lämnat gaten
    if (r.type === "takeoff") await releasePilotGates(db, r.pilot, r.airport);
  } else {
    throw bad("Okänd åtgärd.");
  }
  r.note = String(note || "").trim().slice(0, 140) || r.note || "";
  r.decidedBy = me.username;
  r.updatedAt = now;
  await db.requests.setJSON("r/" + r.id, r);
  const verb = { approve: "godkände", deny: "nekade", complete: "avslutade tillståndet för" }[action];
  await logEvent(db, me, `${verb} ${r.flightNumber} (${TYPE_SV[r.type]}, bana ${r.runway}) vid ${(findAirport(r.airport) || {}).name || r.airport}`, { airport: r.airport });
  return json({ request: r });
}

// Pilotens egen avslutning: lyckad landning eller start. Frigör banan och, vid start, gaten.
async function finishRequest(db, me, r) {
  const now = Date.now();
  r.status = "completed";
  r.completedBy = "pilot";
  r.updatedAt = now;
  await db.requests.setJSON("r/" + r.id, r);
  if (r.type === "landing") {
    const f = await db.enroute.get(r.pilot.toLowerCase(), { type: "json" });
    if (f && f.airport === r.airport) await db.enroute.delete(r.pilot.toLowerCase());
  } else {
    await releasePilotGates(db, r.pilot, r.airport);
  }
  await logEvent(db, me, `${r.type === "landing" ? "landade" : "lyfte"} (${r.flightNumber}, bana ${r.runway}) vid ${(findAirport(r.airport) || {}).name || r.airport}`, { airport: r.airport });
  return r;
}

async function pilotDone(me, db, id) {
  const r = await getRequest(db, id);
  if (me.role !== "pilot" || r.pilot !== me.username) throw new HttpError(403, "Du kan bara avsluta dina egna förfrågningar.");
  if (r.status !== "approved") throw new HttpError(409, "Du kan bara anmäla landning eller start när ATC har godkänt.");
  return json({ request: await finishRequest(db, me, r) });
}

async function cancel(me, db, id) {
  const r = await getRequest(db, id);
  if (me.role !== "pilot" || r.pilot !== me.username) throw new HttpError(403, "Du kan bara avbryta dina egna förfrågningar.");
  if (!ACTIVE.includes(r.status)) throw new HttpError(409, "Förfrågan är redan avslutad.");
  r.status = "cancelled";
  r.updatedAt = Date.now();
  await db.requests.setJSON("r/" + r.id, r);
  await logEvent(db, me, `avbröt sin förfrågan (${r.flightNumber}, bana ${r.runway})`, { airport: r.airport });
  return json({ request: r });
}

/* ------------------------------------------------------------------ */
/*  Admin                                                              */
/* ------------------------------------------------------------------ */
async function adminUsers(db) {
  const { blobs } = await db.users.list();
  const rows = (await Promise.all(blobs.map((b) => db.users.get(b.key, { type: "json" })))).filter(Boolean);
  const order = { pending: 0, approved: 1, rejected: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
  return json({ users: rows.map(publicUser) });
}

async function adminUserAction(req, db, name, action) {
  const key = String(name).toLowerCase();
  if (!/^[a-z0-9_]{3,16}$/.test(key)) throw new HttpError(404, "Kontot finns inte.");
  const u = await db.users.get(key, { type: "json" });
  if (!u) throw new HttpError(404, "Kontot finns inte.");

  if (action === "approve") u.status = "approved";
  else if (action === "reject") u.status = "rejected";
  else if (action === "delete") {
    await db.users.delete(key);
    await db.presence.delete(key);
    await db.enroute.delete(key);
    await db.seen.delete(key);
    await releasePilotGates(db, u.username);
    await db.emergencies.delete("n/" + key);
    return json({ ok: true });
  } else if (action === "password") {
    const { password } = await readBody(req);
    if (typeof password !== "string" || password.length < 6 || password.length > 100) throw bad("Lösenordet måste vara minst 6 tecken.");
    const { salt, hash } = await hashPw(password);
    u.salt = salt;
    u.hash = hash;
  } else throw bad("Okänd åtgärd.");

  await db.users.setJSON(key, u);
  if (u.status !== "approved") {
    await db.presence.delete(key);
    await db.enroute.delete(key);
    await releasePilotGates(db, u.username);
  }
  return json({ user: publicUser(u) });
}

/* ---------------- Pilot lämnar sin gate ---------------- */
async function leaveGate(me, db) {
  if (me.role !== "pilot") throw new HttpError(403, "Endast piloter kan lämna sin egen gate.");
  const mine = (await loadGates(db)).filter((g) => g.pilot === me.username);
  for (const g of mine) {
    await db.gates.delete(`${g.airport}/${g.gate}`);
    await logEvent(db, me, `lämnade Gate ${g.gate} vid ${(findAirport(g.airport) || {}).name || g.airport}`, { airport: g.airport });
  }
  return json({ ok: true });
}

/* ---------------- Gater: tilldela och frigör (ATC på plats eller admin) ---------------- */
async function gateAction(req, me, db, id, action) {
  const ap = findAirport(id);
  if (!ap) throw new HttpError(404, "Flygplatsen finns inte.");
  const allowed = me.role === "admin" || (me.role === "atc" && me.airport === id);
  if (!allowed) throw new HttpError(403, "Du är inte på tjänst vid den här flygplatsen.");
  const body = await readBody(req);
  const rows = await loadGates(db);

  if (action === "gate-release") {
    const g = rows.find((r) => r.airport === id && r.gate === String(body.gate));
    if (!g) throw new HttpError(404, "Gaten är inte tilldelad.");
    await db.gates.delete(`${id}/${g.gate}`);
    await logEvent(db, me, `frigjorde Gate ${g.gate} vid ${ap.name} (${g.flightNumber || g.pilot})`, { airport: id });
    return json({ ok: true });
  }
  if (action !== "gate-assign") throw bad("Okänd åtgärd.");

  const terminal = ap.terminals.find((t) => t.id === body.terminal);
  if (!terminal) throw bad("Välj en terminal.");
  const gate = String(body.gate || "");
  if (!terminal.gates.includes(gate)) throw bad("Gaten finns inte i den terminalen.");

  const key = String(body.pilot || "").toLowerCase();
  if (!/^[a-z0-9_]{3,16}$/.test(key)) throw bad("Välj vilken pilot som ska få gaten.");
  const pilot = await db.users.get(key, { type: "json" });
  if (!pilot || pilot.role !== "pilot" || pilot.status !== "approved") throw bad("Piloten finns inte.");

  const taken = rows.find((r) => r.airport === id && r.gate === gate);
  if (taken && taken.pilot === pilot.username) return json({ gate: taken }); // redan tilldelad, inget att göra
  if (taken) throw new HttpError(409, `Gate ${gate} är upptagen av ${taken.flightNumber || taken.pilot}. Välj en annan gate.`);

  const [reqs, msgs, enroute] = await Promise.all([loadRequests(db), loadMessages(db), loadEnroute(db)]);
  if (!contactsFor(id, reqs, msgs, enroute).has(pilot.username))
    throw bad("Piloten har ingen koppling till flygplatsen än. Piloter kan få gate när de har en förfrågan, är på väg hit eller har skickat ACARS hit.");

  // En pilot har en gate åt gången: en tidigare gate släpps
  for (const prev of rows) if (prev.pilot === pilot.username) await db.gates.delete(`${prev.airport}/${prev.gate}`);

  const rec = { airport: id, terminal: terminal.id, terminalName: terminal.name, gate, pilot: pilot.username, flightNumber: pilot.flightNumber || "", airline: pilot.airline || "", by: me.username, at: Date.now() };
  await db.gates.setJSON(`${id}/${gate}`, rec);
  await logEvent(db, me, `tilldelade ${pilot.flightNumber || pilot.username} Gate ${gate}, ${terminal.name} vid ${ap.name}`, { airport: id });
  return json({ gate: rec }, 201);
}

/* ---------------- Flygplatsstatus (ATC på plats eller admin) ---------------- */
async function airportAction(req, me, db, id, action) {
  const ap = findAirport(id);
  if (!ap) throw new HttpError(404, "Flygplatsen finns inte.");
  const allowed = me.role === "admin" || (me.role === "atc" && me.airport === id);
  if (!allowed) throw new HttpError(403, "Du är inte på tjänst vid den här flygplatsen.");

  const body = await readBody(req);
  const st = await getStatus(db, id);
  const clean = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
  const now = Date.now();
  let logText;

  if (action === "close") {
    st.closed = true;
    st.reason = clean(body.reason, 100);
    st.closedBy = me.username;
    st.closedAt = now;
    logText = `stängde ${ap.name}${st.reason ? ": " + st.reason : ""}`;
  } else if (action === "open") {
    st.closed = false;
    st.reason = "";
    st.closedBy = null;
    st.closedAt = null;
    logText = `öppnade ${ap.name}`;
  } else if (action === "runway") {
    if (!ap.runways.includes(body.runway)) throw bad("Banan finns inte på den flygplatsen.");
    if (body.closed) {
      st.runways[body.runway] = { reason: clean(body.reason, 100), by: me.username, at: now };
      logText = `stängde bana ${body.runway} vid ${ap.name}${st.runways[body.runway].reason ? ": " + st.runways[body.runway].reason : ""}`;
    } else {
      delete st.runways[body.runway];
      logText = `öppnade bana ${body.runway} vid ${ap.name}`;
    }
  } else if (action === "notice-add") {
    const text = clean(body.text, 100);
    if (!text) throw bad("Skriv en information.");
    if (st.notices.length >= 10) throw bad("Det finns redan 10 informationsrader. Ta bort någon först.");
    st.notices.push({ id: now.toString(36) + "-" + crypto.randomBytes(2).toString("hex"), text, by: me.username, createdAt: now });
    logText = `la ut information vid ${ap.name}: "${short(text)}"`;
  } else if (action === "notice-remove") {
    const before = st.notices.length;
    st.notices = st.notices.filter((n) => n.id !== body.id);
    if (st.notices.length === before) throw new HttpError(404, "Informationen finns inte.");
    logText = `tog bort information vid ${ap.name}`;
  } else {
    throw bad("Okänd åtgärd.");
  }
  await db.airportstatus.setJSON(id, st);
  await logEvent(db, me, logText, { airport: id });
  return json({ ok: true });
}

/* ---------------- Väder och tid på dygnet (ATC och admin, en eller flera flygplatser) ---------------- */
async function setConditions(req, me, db) {
  if (me.role !== "admin" && me.role !== "atc") throw new HttpError(403, "Endast ATC och admin kan rapportera väder och tid.");
  const body = await readBody(req);
  const ids = body.airports === "all" ? AIRPORTS.map((a) => a.id) : Array.isArray(body.airports) ? [...new Set(body.airports.map(String))] : [];
  if (!ids.length) throw bad("Välj minst en flygplats.");
  const aps = ids.map((id) => findAirport(id));
  if (aps.some((a) => !a)) throw bad("Okänd flygplats.");
  const hasW = body.weather !== undefined, hasT = body.time !== undefined;
  if (!hasW && !hasT) throw bad("Välj väder eller tid på dygnet.");
  if (hasW && body.weather !== null && !WEATHER[body.weather]) throw bad("Okänt väder.");
  if (hasT && body.time !== null && !TIMEOFDAY[body.time]) throw bad("Okänd tid på dygnet.");
  const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const now = Date.now();
  for (const ap of aps) {
    const st = await getStatus(db, ap.id);
    if (hasW) st.weather = body.weather ? { kind: body.weather, note, by: me.username, at: now } : null;
    if (hasT) st.tod = body.time ? { kind: body.time, by: me.username, at: now } : null;
    await db.airportstatus.setJSON(ap.id, st);
  }
  const where = aps.length === AIRPORTS.length ? "alla flygplatser" : aps.map((a) => a.name).join(", ");
  const parts = [];
  if (hasW) parts.push(body.weather ? `väder ${WEATHER[body.weather].toLowerCase()}${note ? " (" + note + ")" : ""}` : "tog bort vädret");
  if (hasT) parts.push(body.time ? `tid på dygnet ${TIMEOFDAY[body.time].toLowerCase()}` : "tog bort tid på dygnet");
  await logEvent(db, me, `rapporterade ${parts.join(" och ")} för ${short(where, 120)}`, { airport: aps.length === 1 ? aps[0].id : undefined });
  return json({ ok: true, airports: aps.length });
}

/* ---------------- Nödläge ---------------- */
async function loadEmergencies(db) {
  const now = Date.now();
  const { blobs } = await db.emergencies.list({ prefix: "n/" });
  const all = (await Promise.all(blobs.map((b) => db.emergencies.get(b.key, { type: "json" })))).filter(Boolean);
  const out = [];
  for (const e of all) {
    if (now - e.createdAt > EMERGENCY_TTL || (e.status === "resolved" && now - (e.resolvedAt || e.createdAt) > 30 * 60 * 1000)) {
      await db.emergencies.delete("n/" + e.pilot.toLowerCase());
      continue;
    }
    out.push(e);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function visibleEmergencies(me, list) {
  const pub = (e) => ({ ...e, kindLabel: EMERGENCY_KINDS[e.kind] });
  if (me.role === "admin") return list.map(pub);
  if (me.role === "atc") return me.airport ? list.filter((e) => e.airport === me.airport).map(pub) : [];
  return list.filter((e) => e.pilot === me.username).map(pub);
}

async function declareEmergency(req, me, db) {
  if (me.role !== "pilot") throw new HttpError(403, "Endast piloter kan anmäla nödläge.");
  if (!me.flightNumber || !me.airline) throw bad("Registrera flygnummer och flygbolag först.");
  const body = await readBody(req);
  const ap = findAirport(body.airport);
  if (!ap) throw bad("Välj flygplatsen där du behöver hjälp.");
  const runway = body.runway ? String(body.runway) : null;
  if (runway && !ap.runways.includes(runway)) throw bad("Banan finns inte på den flygplatsen.");
  if (!EMERGENCY_KINDS[body.kind]) throw bad("Välj typ av nödläge.");
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const key = "n/" + me.username.toLowerCase();
  const had = await db.emergencies.get(key, { type: "json" });
  if (had && had.status !== "resolved") throw new HttpError(409, "Du har redan ett pågående nödläge.");
  const e = {
    id: Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex"),
    pilot: me.username, flightNumber: me.flightNumber, airline: me.airline,
    airport: ap.id, runway, kind: body.kind, text, status: "active",
    createdAt: Date.now(), helpAt: null, helpBy: null, helpRunway: null, resolvedAt: null, resolvedBy: null,
  };
  await db.emergencies.setJSON(key, e);
  await logEvent(db, me, `anmälde NÖDLÄGE (${EMERGENCY_KINDS[e.kind].toLowerCase()}) vid ${ap.name}${runway ? ", bana " + runway : ""} (${me.flightNumber})`, { airport: ap.id });
  return json({ emergency: { ...e, kindLabel: EMERGENCY_KINDS[e.kind] } }, 201);
}

// id = pilotens användarnamn. help: skicka hjälp till bana (ATC på plats/admin). resolve: avsluta (ATC, admin eller piloten själv).
async function emergencyAction(req, me, db, pilot, action) {
  const key = "n/" + String(pilot).toLowerCase();
  const e = await db.emergencies.get(key, { type: "json" });
  if (!e || e.status === "resolved") throw new HttpError(404, "Nödläget finns inte eller är avslutat.");
  const isStaff = me.role === "admin" || (me.role === "atc" && me.airport === e.airport);
  const ap = findAirport(e.airport);
  const now = Date.now();
  if (action === "help") {
    if (!isStaff) throw new HttpError(403, "Du är inte på tjänst vid den här flygplatsen.");
    const { runway } = await readBody(req);
    const rw = String(runway || e.runway || "");
    if (!ap.runways.includes(rw)) throw bad("Välj bana att skicka hjälp till.");
    e.status = "help-sent"; e.helpAt = now; e.helpBy = me.username; e.helpRunway = rw;
    await db.emergencies.setJSON(key, e);
    await logEvent(db, me, `skickade hjälp till bana ${rw} vid ${ap.name} (${e.flightNumber})`, { airport: e.airport });
  } else if (action === "resolve") {
    if (!isStaff && !(me.role === "pilot" && me.username === e.pilot)) throw new HttpError(403, "Du kan inte avsluta det här nödläget.");
    e.status = "resolved"; e.resolvedAt = now; e.resolvedBy = me.username;
    await db.emergencies.setJSON(key, e);
    await logEvent(db, me, `avslutade nödläget för ${e.flightNumber} vid ${ap.name}`, { airport: e.airport });
  } else throw bad("Okänd åtgärd.");
  return json({ ok: true });
}

/* ---------------- Aktivitet: vad ATC och piloter gör just nu (admin) ---------------- */
async function adminActivity(db) {
  const now = Date.now();
  const [users, seenRows, enroute, reqs, events] = await Promise.all([
    db.users.list().then(({ blobs }) => Promise.all(blobs.map((b) => db.users.get(b.key, { type: "json" })))),
    db.seen.list().then(({ blobs }) => Promise.all(blobs.map((b) => db.seen.get(b.key, { type: "json" })))),
    loadEnroute(db),
    loadRequests(db),
    loadEvents(db),
  ]);
  const seen = new Map(seenRows.filter(Boolean).map((s) => [s.username.toLowerCase(), s]));
  const people = users
    .filter((u) => u && u.status === "approved" && (u.role === "pilot" || u.role === "atc"))
    .map((u) => {
      const s = seen.get(u.username.toLowerCase());
      const p = { username: u.username, role: u.role, lastSeen: s ? s.at : null, online: !!s && !s.out && now - s.at < SEEN_ONLINE };
      if (u.role === "pilot") {
        const q = reqs.find((r) => r.pilot === u.username && ACTIVE.includes(r.status));
        const f = enroute.find((x) => x.username === u.username);
        Object.assign(p, {
          flightNumber: u.flightNumber || "",
          airline: u.airline || "",
          destination: u.destination || "",
          request: q ? { status: q.status, type: q.type, runway: q.runway, airport: q.airport } : null,
          enroute: f ? { destination: f.destination, airport: f.airport, eta: f.eta } : null,
        });
      } else {
        p.airport = u.airport || null;
      }
      return p;
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen || 0) - (a.lastSeen || 0) || a.username.localeCompare(b.username));
  return json({ people, events, now });
}

async function adminDeleteRequest(db, id) {
  await getRequest(db, id);
  await db.requests.delete("r/" + id);
  return json({ ok: true });
}

async function adminClearRequests(req, db) {
  const { scope } = await readBody(req);
  if (scope !== "finished" && scope !== "all") throw bad("Okänd åtgärd.");
  const { blobs } = await db.requests.list({ prefix: "r/" });
  let deleted = 0;
  for (const b of blobs) {
    const r = await db.requests.get(b.key, { type: "json" });
    if (!r) continue;
    if (scope === "all" || !ACTIVE.includes(r.status)) {
      await db.requests.delete(b.key);
      deleted++;
    }
  }
  return json({ ok: true, deleted });
}

async function adminDeleteMessage(db, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, "Meddelandet hittades inte.");
  const m = await db.messages.get("m/" + id, { type: "json" });
  if (!m) throw new HttpError(404, "Meddelandet hittades inte.");
  await db.messages.delete("m/" + id);
  return json({ ok: true });
}

async function adminClearMessages(db) {
  const { blobs } = await db.messages.list({ prefix: "m/" });
  for (const b of blobs) await db.messages.delete(b.key);
  return json({ ok: true, deleted: blobs.length });
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */
async function route(req, db) {
  const url = new URL(req.url);
  let seg;
  try {
    seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw bad("Ogiltig adress.");
  }
  const m = req.method;
  const [a, b, c, d] = seg;

  if (m === "POST" && a === "register" && !b) return register(req, db);
  if (m === "POST" && a === "login" && !b) return login(req, db);

  const auth = await authenticate(req, db);
  if (!auth) throw new HttpError(401, "Du är inte inloggad.");
  const { me, sessionKey } = auth;

  if (m === "POST" && a === "logout") {
    await db.sessions.delete(sessionKey);
    if (me.role !== "admin") {
      await touchSeen(db, me, { force: true, out: true });
      await logEvent(db, me, "loggade ut");
    }
    return json({ ok: true });
  }
  if (m === "GET" && a === "me") return json({ me: publicUser(me) });
  if (m === "GET" && a === "state") return state(me, db);
  if (m === "POST" && a === "profile") return profile(req, me, db);
  if (m === "POST" && a === "requests" && !b) return createRequest(req, me, db);
  if (m === "POST" && a === "requests" && b && c === "decide") return decide(req, me, db, b);
  if (m === "POST" && a === "requests" && b && c === "cancel") return cancel(me, db, b);
  if (m === "POST" && a === "requests" && b && c === "done") return pilotDone(me, db, b);
  if (m === "POST" && a === "conditions" && !b) return setConditions(req, me, db);
  if (m === "POST" && a === "emergency" && !b) return declareEmergency(req, me, db);
  if (m === "POST" && a === "emergency" && b && c) return emergencyAction(req, me, db, b, c);
  if (m === "POST" && a === "messages" && !b) return sendMessage(req, me, db);
  if (m === "POST" && a === "enroute" && !b) return setEnroute(req, me, db);
  if (m === "POST" && a === "gate" && b === "leave" && !c) return leaveGate(me, db);
  if (m === "POST" && a === "announcements" && !b) return createAnnouncement(req, me, db);
  if (m === "POST" && a === "announcements" && b && c === "delete") return deleteAnnouncement(me, db, b);
  if (m === "POST" && a === "airports" && b && c && !d) return c.startsWith("gate-") ? gateAction(req, me, db, b, c) : airportAction(req, me, db, b, c);

  if (a === "admin") {
    if (me.role !== "admin") throw new HttpError(403, "Endast admin.");
    if (m === "POST" && b === "requests" && c === "clear" && !d) return adminClearRequests(req, db);
    if (m === "POST" && b === "requests" && c && d === "delete") return adminDeleteRequest(db, c);
    if (m === "POST" && b === "messages" && c === "clear" && !d) return adminClearMessages(db);
    if (m === "POST" && b === "messages" && c && d === "delete") return adminDeleteMessage(db, c);
    if (m === "GET" && b === "activity" && !c) return adminActivity(db);
    if (m === "GET" && b === "users" && !c) return adminUsers(db);
    if (m === "POST" && b === "users" && c && d) return adminUserAction(req, db, c, d);
  }
  throw new HttpError(404, "Hittades inte.");
}

export function createHandler(getStoreFn) {
  const open = (name) => getStoreFn({ name, consistency: "strong" });
  return async function handler(req) {
    try {
      const db = {
        users: open("users"),
        sessions: open("sessions"),
        requests: open("requests"),
        presence: open("presence"),
        messages: open("messages"),
        enroute: open("enroute"),
        activity: open("activity"),
        gates: open("gates"),
        emergencies: open("emergencies"),
        seen: open("seen"),
        announcements: open("announcements"),
        airportstatus: open("airportstatus"),
        throttle: open("throttle"),
      };
      return await route(req, db);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Serverfel. Försök igen." }, 500);
    }
  };
}

export default createHandler(getStore);

export const config = { path: "/api/*" };
