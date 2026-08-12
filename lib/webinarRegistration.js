const WG_API = "https://app.webinargeek.com/api/v2";
const EASY2_API = "https://yogini-glow.easy2.de/api/site";

// Deutsche 3-Buchstaben-Monatskuerzel, wie sie in den aktuellsten echten
// Easy2-Tags verwendet werden (per API verifiziert 2026-08-08: "Web_19Jul26_
// angemeldet", "Web_30Aug26_angemeldet" - neueste Konvention, aeltere Tags
// waren uneinheitlich: mal ohne Jahr, mal volles "April", mal ganz ohne Tag).
const GERMAN_MONTH_ABBR = ["Jan", "Feb", "Mrz", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// Es gibt laut Pierre (2026-08-08) dauerhaft nur EIN aktives Webinar ("Yoga
// Shift 2026 - Yoga Expertin fuer Frauengesundheit", webinar id 517362, alle
// 4 Wochen ein neuer Termin). Konfigurierbar per ENV, falls sich das je
// aendert oder ein neues Webinar dessen Rolle uebernimmt.
const MAIN_WEBINAR_ID = Number(process.env.WEBINARGEEK_MAIN_WEBINAR_ID || 517362);

function wgHeaders() {
  return { "Api-Token": process.env.WEBINARGEEK_API_TOKEN, "Content-Type": "application/json" };
}

class WebinarGeekApiError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function wgFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: wgHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WebinarGeekApiError(
      `WebinarGeek ${options.method || "GET"} ${url} -> HTTP ${res.status}: ${JSON.stringify(data)}`,
      { status: res.status, data }
    );
  }
  return data;
}

// Real bestaetigt 2026-08-08 (echte Doppel-Zustellung vom selben Easy2-Kontakt):
// WebinarGeeks eigene API-Doku behauptet, eine Doppel-Registrierung (gleiche
// Email + gleicher Termin) werde "silently skip[ped]" - stimmt NICHT, die API
// antwortet mit HTTP 422 {"errors":[{"field":"email","message":"is already
// registered to this broadcast"}]}. Muessen wir selbst als Erfolgsfall
// behandeln, sonst wirft jede Wiederholzustellung (Easy2 schickt denselben
// Kontakt bei jeder Aenderung erneut) einen Fehler.
function isAlreadyRegisteredError(err) {
  if (!(err instanceof WebinarGeekApiError) || err.status !== 422) return false;
  const errors = err.data?.errors || [];
  return errors.some((e) => /already registered/i.test(e.message || ""));
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
 * `contact` fuer den naechsten Termin des Haupt-Webinars. Easy2 schickt bei
 * JEDER Aenderung am Kontakt (z.B. neue Liste, neuer Tag) den `form_submitted`-
 * Event erneut - deshalb muss eine Doppel-Registrierung (gleiche Email +
 * gleicher Termin) hier explizit als Erfolg behandelt werden, s.u.
 * `skipConfirmationMail` nur fuer eigene Tests nutzen, NIE bei echten
 * Kontakten (sonst bekommt die Person keine Zugangs-Mail!).
 */
export async function registerForNextBroadcast(contact, { skipConfirmationMail = false, utm = null } = {}) {
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
    // WebinarGeeks "extra_fields" sind an intern konfigurierte Formularfelder
    // gebunden (extra_field_123 o.ae.), kein freier UTM-Schluessel - deshalb
    // UTM-Daten stattdessen im freien custom_field als JSON durchschleusen.
    // Kommt im Webhook-Payload (sub.custom_field) zurueck und wird dort von
    // processRegistration() bevorzugt gegenueber extra_fields/Defaults gelesen
    // (siehe lib/registration.js) - so bleibt EINE Quelle der Wahrheit fuer den
    // Lead statt eines zweiten, potenziell widerspruechlichen Airtable-Writes.
    custom_field: utm ? JSON.stringify(utm) : undefined,
  };
  // undefined-Felder raus, WebinarGeek mag ggf. keine expliziten nulls.
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  let sub = null;
  let action = "registered";
  try {
    sub = await wgFetch(`${WG_API}/broadcasts/${broadcast.id}/subscriptions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (!isAlreadyRegisteredError(err)) throw err;
    console.log(`[webinarRegistration] ${email} war bereits fuer Broadcast ${broadcast.id} registriert - kein Fehler, no-op.`);
    action = "already_registered";
  }

  let easy2Tag = null;
  try {
    easy2Tag = await tagEasy2ForBroadcast(email, broadcast.date);
  } catch (err) {
    // Tag ist Nice-to-have (Reporting/Nurture) - die eigentliche Registrierung
    // ist bereits erfolgreich, deshalb hier NICHT die ganze Funktion scheitern
    // lassen, nur loggen.
    console.warn(`[webinarRegistration] Easy2-Tag setzen fehlgeschlagen fuer ${email}:`, err?.message);
    easy2Tag = { error: err?.message };
  }

  return {
    action,
    broadcastId: broadcast.id,
    broadcastDate: broadcast.date,
    subscriptionId: sub?.id ?? null,
    easy2Tag,
  };
}

/**
 * Baut den Tag im aktuellen Format (z.B. "Web_30Aug26_angemeldet", zweistelliger
 * Tag + dt. Monatskuerzel + zweistelliges Jahr) und setzt ihn auf dem Easy2-
 * Kontakt via POST /contacts. Das ist ein additiver Upsert (live verifiziert
 * 2026-08-08: bestehende Tags/Listen bleiben erhalten, kein Ueberschreiben) -
 * ersetzt das manuelle Nachpflegen des Tag-Strings in der alten Zap-Config bei
 * jedem neuen Webinar-Zyklus.
 */
export async function tagEasy2ForBroadcast(email, broadcastDateUnix) {
  if (!process.env.EASY2_API_KEY) {
    return { skipped: true, reason: "no EASY2_API_KEY" };
  }
  const d = new Date(broadcastDateUnix * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = GERMAN_MONTH_ABBR[d.getUTCMonth()];
  const year = String(d.getUTCFullYear()).slice(-2);
  const tag = `Web_${day}${month}${year}_angemeldet`;

  const res = await fetch(`${EASY2_API}/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.EASY2_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, tags: [tag] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) {
    throw new Error(`Easy2 POST /contacts (Tag) -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return { tag, contactId: data.id };
}
