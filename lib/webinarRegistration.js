const WG_API = "https://app.webinargeek.com/api/v2";

// Es gibt laut Pierre (2026-08-08) dauerhaft nur EIN aktives Webinar ("Yoga
// Shift 2026 - Yoga Expertin fuer Frauengesundheit", webinar id 517362, alle
// 4 Wochen ein neuer Termin). Konfigurierbar per ENV, falls sich das je
// aendert oder ein neues Webinar dessen Rolle uebernimmt.
const MAIN_WEBINAR_ID = Number(process.env.WEBINARGEEK_MAIN_WEBINAR_ID || 517362);

function wgHeaders() {
  return { "Api-Token": process.env.WEBINARGEEK_API_TOKEN, "Content-Type": "application/json" };
}

async function wgFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: wgHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WebinarGeek ${options.method || "GET"} ${url} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Findet den naechsten NOCH NICHT stattgefundenen Termin (broadcast) des
 * Haupt-Webinars - dynamisch bei jedem Aufruf ermittelt, NICHT hartkodiert.
 * Damit "datiert" sich die Registrierung automatisch auf den naechsten
 * Termin um, sobald Pierre nach einem Webinar den naechsten Termin in
 * WebinarGeek anlegt (kein Code-Redeploy noetig).
 */
export async function findNextBroadcast() {
  const data = await wgFetch(`${WG_API}/webinars`);
  const webinar = (data.webinars || []).find((w) => w.id === MAIN_WEBINAR_ID);
  if (!webinar) {
    throw new Error(`Webinar ${MAIN_WEBINAR_ID} nicht gefunden - webinars: ${JSON.stringify((data.webinars || []).map((w) => w.id))}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = [];
  for (const ep of webinar.episodes || []) {
    for (const b of ep.broadcasts || []) {
      if (!b.cancelled && !b.has_ended && b.date > nowSec) candidates.push(b);
    }
  }
  candidates.sort((a, b) => a.date - b.date);
  if (!candidates.length) {
    throw new Error(`Kein zukuenftiger Termin fuer Webinar ${MAIN_WEBINAR_ID} gefunden - Pierre muss vermutlich einen neuen Termin in WebinarGeek anlegen.`);
  }
  return candidates[0]; // fruehester zukuenftiger Termin
}

function splitName(fullName) {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { first: "", last: "" };
  const parts = trimmed.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Ersetzt den Zap "Easy2 to Webinargeek Anmeldung" (Add Registrant). Registriert
 * `contact` fuer den naechsten Termin des Haupt-Webinars. WebinarGeek ist laut
 * eigener API-Doku bei Doppel-Registrierung (gleiche Email + gleicher Termin)
 * idempotent ("will silently skip the subscription") - sicher fuer Parallelbetrieb
 * neben dem bestehenden Zap. `skipConfirmationMail` nur fuer eigene Tests nutzen,
 * NIE bei echten Kontakten (sonst bekommt die Person keine Zugangs-Mail!).
 */
export async function registerForNextBroadcast(contact, { skipConfirmationMail = false } = {}) {
  const email = (contact.email || "").trim();
  if (!email) return { skipped: true, reason: "keine email im Payload" };

  const broadcast = await findNextBroadcast();
  const { first, last } = splitName(contact.name);

  const body = {
    firstname: first || email.split("@")[0],
    email,
    surname: last || undefined,
    phone: contact.phone || undefined,
    external_id: contact.id != null ? String(contact.id) : undefined,
    skip_confirmation_mail: skipConfirmationMail,
  };
  // undefined-Felder raus, WebinarGeek mag ggf. keine expliziten nulls.
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const sub = await wgFetch(`${WG_API}/broadcasts/${broadcast.id}/subscriptions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { action: "registered", broadcastId: broadcast.id, broadcastDate: broadcast.date, subscriptionId: sub.id };
}
