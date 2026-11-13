// EDU Air Control – backend (Netlify Function v2 + Netlify Blobs)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/* ------------------------------------------------------------------ */
/*  Flygplatser (servern är sanningskälla för banor)                   */
/* ------------------------------------------------------------------ */
export const AIRPORTS = [
  { id: "katrineholm-kattport", name: "Katrineholm Kattport International Airport", runways: ["1A", "2A", "3A", "4A", "1B", "2B", "3B", "4B"] },
  { id: "malmo", name: "Malmö International Airport", runways: ["1"] },
  { id: "uk", name: "UK International Airport", runways: ["1"] },
  { id: "hallonbergen", name: "Hallonbergen Airport", runways: ["1"] },
  { id: "katrineholm-halvon", name: "Katrineholm Halvön Airport", runways: ["1"] },
  { id: "turkmenistan", name: "Turkmenistan Internationella Flygfält", runways: ["1"] },
  { id: "borgvik", name: "Borgvik Airport", runways: ["1"] },
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

const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
const FLIGHT_RE = /^[A-Z0-9][A-Z0-9 \-]{1,11}$/;
const AIRLINE_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'\-]{1,39}$/u;

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
  airport: u.airport || null,
  createdAt: u.createdAt || null,
});

const findAirport = (id) => AIRPORTS.find((a) => a.id === id);

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
  return newSession(db, u);
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

function buildAirports(reqs, presence) {
  return AIRPORTS.map((a) => {
    const runwayStatus = Object.fromEntries(a.runways.map((rw) => [rw, null]));
    let pending = 0;
    for (const r of reqs) {
      if (r.airport !== a.id) continue;
      if (r.status === "approved" && r.runway in runwayStatus)
        runwayStatus[r.runway] = {
          requestId: r.id,
          flightNumber: r.flightNumber,
          airline: r.airline,
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
    };
  });
}

async function state(me, db) {
  await heartbeat(db, me);
  const [reqs, presence] = await Promise.all([loadRequests(db), loadPresence(db)]);
  let visible = [];
  if (me.role === "pilot") visible = reqs.filter((r) => r.pilot === me.username).slice(0, 25);
  else if (me.role === "atc" && me.airport) visible = reqs.filter((r) => r.airport === me.airport).slice(0, 80);
  else if (me.role === "admin") visible = reqs.slice(0, 100);
  return json({ me: publicUser(me), airports: buildAirports(reqs, presence), requests: visible, now: Date.now() });
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
    u.flightNumber = flightNumber;
    u.airline = airline;
    await db.users.setJSON(key, u);
    return json({ me: publicUser(u) });
  }

  if (me.role === "atc") {
    const airport = body.airport || null;
    if (airport !== null && !findAirport(airport)) throw bad("Okänd flygplats.");
    u.airport = airport;
    await db.users.setJSON(key, u);
    if (airport) await db.presence.setJSON(key, { username: u.username, airport, lastSeen: Date.now() });
    else await db.presence.delete(key);
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
  return json({ request: r }, 201);
}

async function getRequest(db, id) {
  if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) throw new HttpError(404, "Förfrågan hittades inte.");
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
  } else {
    throw bad("Okänd åtgärd.");
  }
  r.note = String(note || "").trim().slice(0, 140) || r.note || "";
  r.decidedBy = me.username;
  r.updatedAt = now;
  await db.requests.setJSON("r/" + r.id, r);
  return json({ request: r });
}

async function cancel(me, db, id) {
  const r = await getRequest(db, id);
  if (me.role !== "pilot" || r.pilot !== me.username) throw new HttpError(403, "Du kan bara avbryta dina egna förfrågningar.");
  if (!ACTIVE.includes(r.status)) throw new HttpError(409, "Förfrågan är redan avslutad.");
  r.status = "cancelled";
  r.updatedAt = Date.now();
  await db.requests.setJSON("r/" + r.id, r);
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
    return json({ ok: true });
  } else if (action === "password") {
    const { password } = await readBody(req);
    if (typeof password !== "string" || password.length < 6 || password.length > 100) throw bad("Lösenordet måste vara minst 6 tecken.");
    const { salt, hash } = await hashPw(password);
    u.salt = salt;
    u.hash = hash;
  } else throw bad("Okänd åtgärd.");

  await db.users.setJSON(key, u);
  if (u.status !== "approved") await db.presence.delete(key);
  return json({ user: publicUser(u) });
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
    return json({ ok: true });
  }
  if (m === "GET" && a === "me") return json({ me: publicUser(me) });
  if (m === "GET" && a === "state") return state(me, db);
  if (m === "POST" && a === "profile") return profile(req, me, db);
  if (m === "POST" && a === "requests" && !b) return createRequest(req, me, db);
  if (m === "POST" && a === "requests" && b && c === "decide") return decide(req, me, db, b);
  if (m === "POST" && a === "requests" && b && c === "cancel") return cancel(me, db, b);

  if (a === "admin") {
    if (me.role !== "admin") throw new HttpError(403, "Endast admin.");
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
