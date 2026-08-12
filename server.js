import express from "express";
import crypto from "node:crypto";
import { processRegistration } from "./lib/registration.js";
import { processFormSubmitted } from "./lib/leadMagnet.js";
import { registerForNextBroadcast } from "./lib/webinarRegistration.js";
import { alertFailure } from "./lib/alert.js";

const {
  PORT = 3000,
  WEBINARGEEK_WEBHOOK_SECRET,
  WEBINARGEEK_API_TOKEN,
  EASY2_WEBHOOK_SECRET,
  // Easy2-Subscriber-Liste, die "hat sich fuers Webinar angemeldet" signalisiert
  // (live verifiziert 2026-08-08 an echten Kontakten: Liste "8. Webinar Anmeldung").
  EASY2_WEBINAR_SIGNUP_LIST_ID = "238677122",
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  // Shared Secret fuer POST /register-lead (von der eigenen Landing Page
  // shift.yogini-glow.de aufgerufen, oeffentlich erreichbar). Ohne dieses
  // Secret laeuft der Endpoint, aber OHNE Absender-Pruefung - siehe Warnung unten.
  REGISTER_LEAD_SECRET,
  // Komma-getrennte Liste erlaubter Event-Namen fuer "New registration".
  // WebinarGeeks Doku nennt als Beispiel-Payload "webinar_subscribed" - bis der erste
  // echte Webhook durch ist, decken wir gaengige Varianten ab und LOGGEN jedes
  // unbekannte Event laut, statt es zu verwerfen. Nach dem ersten echten Test ggf.
  // per ENV (ohne Code-Aenderung) auf den tatsaechlichen Namen einschraenken.
  WG_REGISTRATION_EVENTS = "webinar_subscribed,participant.registered,subscription_created,registration_created",
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("FATAL: AIRTABLE_TOKEN und/oder AIRTABLE_BASE_ID fehlen in der Umgebung.");
  process.exit(1);
}
if (!WEBINARGEEK_WEBHOOK_SECRET) {
  console.warn(
    "WARNUNG: WEBINARGEEK_WEBHOOK_SECRET ist nicht gesetzt - Signatur-Pruefung ist AUS. " +
      "Nur fuer lokales Testen akzeptabel, niemals so live schalten."
  );
}
if (!EASY2_WEBHOOK_SECRET) {
  console.warn(
    "WARNUNG: EASY2_WEBHOOK_SECRET ist nicht gesetzt - Signatur-Pruefung fuer den " +
      "Easy2-Webhook ist AUS. Nur fuer lokales Testen akzeptabel, niemals so live schalten."
  );
}
if (!WEBINARGEEK_API_TOKEN) {
  console.warn(
    "WARNUNG: WEBINARGEEK_API_TOKEN ist nicht gesetzt - Webinar-Anmeldungen ueber " +
      "die API (Ersatz fuer 'Easy2 to Webinargeek Anmeldung') werden NICHT verarbeitet, " +
      "nur geloggt."
  );
}
if (!REGISTER_LEAD_SECRET) {
  console.warn(
    "WARNUNG: REGISTER_LEAD_SECRET ist nicht gesetzt - /register-lead nimmt Requests " +
      "von JEDEM Absender an. Nur fuer lokales Testen akzeptabel, niemals so live schalten."
  );
}
const EASY2_WEBINAR_SIGNUP_LISTS = new Set(
  EASY2_WEBINAR_SIGNUP_LIST_ID.split(",").map((s) => Number(s.trim())).filter(Boolean)
);

const REGISTRATION_EVENTS = new Set(
  WG_REGISTRATION_EVENTS.split(",").map((s) => s.trim()).filter(Boolean)
);

const app = express();

// Generelles Request-Log VOR allem anderen - damit Verbindungstests (GET/HEAD/OPTIONS
// von WebinarGeek o.ae.), die von keiner Route erfasst werden, trotzdem im Log auftauchen.
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.originalUrl} - UA: ${req.get("user-agent") || "-"}`);
  next();
});

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Manche Webhook-Anbieter pruefen die Erreichbarkeit vorab per GET/HEAD auf dieselbe
// URL, bevor sie das erste echte Event schicken. Beides hier freundlich beantworten,
// damit so ein "Verbindungstest" nicht faelschlich als Fehler gewertet wird.
app.get("/webhooks/webinargeek", (_req, res) => res.status(200).json({ ok: true }));
app.head("/webhooks/webinargeek", (_req, res) => res.sendStatus(200));

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Generische Signatur-Pruefung fuer beide Webhooks (WebinarGeek + Easy2). Beide
// Anbieter dokumentieren den genauen Header-Namen/Format nicht zuverlaessig -
// deshalb pruefen wir mehrere plausible Kandidaten-Header und Hash-Algorithmen,
// und loggen bei Fehlschlag ALLE Header + die selbst berechneten Signaturen zum
// Abgleich. Fuer Easy2 am 2026-08-08 real bestaetigt: Header `X-Webhook-Signature`,
// Algorithmus HMAC-**SHA512** (128 Hex-Zeichen) - nicht SHA256 wie urspruenglich
// angenommen. WebinarGeeks Format ist weiterhin nicht real bestaetigt, deshalb
// bleiben dort beide Algorithmen als Kandidaten drin.
function verifySignatureGeneric(req, secret, label) {
  if (!secret) return true; // s.o. - bewusst nur fuer lokales Testen

  const candidates = [
    req.get("X-Webhook-Signature"), // Easy2, real bestaetigt 2026-08-08
    req.get("Signature"),
    req.get("X-Webinargeek-Signature"),
    req.get("X-Easy2-Signature"),
    req.get("X-Signature"),
    req.get("X-Hub-Signature-256"),
    req.get("X-Hub-Signature"),
  ].filter(Boolean);

  const validValues = new Set();
  for (const algo of ["sha512", "sha256"]) {
    const hex = crypto.createHmac(algo, secret).update(req.rawBody).digest("hex");
    const base64 = crypto.createHmac(algo, secret).update(req.rawBody).digest("base64");
    validValues.add(hex);
    validValues.add(base64);
    validValues.add(`${algo}=${hex}`);
    validValues.add(`${algo}=${base64}`);
  }

  const matched = candidates.some((c) => [...validValues].some((v) => v.length === c.length && safeEqual(v, c)));

  if (!matched) {
    console.warn(`[${label}] Signatur-Check fehlgeschlagen. Alle Header:`, JSON.stringify(req.headers));
    console.warn(`[${label}] erwartete Werte:`, JSON.stringify([...validValues]));
  }
  return matched;
}

function verifySignature(req) {
  return verifySignatureGeneric(req, WEBINARGEEK_WEBHOOK_SECRET, "wg-webhook");
}

app.post("/webhooks/webinargeek", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[wg-webhook] ungueltige/fehlende Signatur - abgelehnt.");
    return res.status(401).json({ error: "invalid signature" });
  }

  const { id, event, entity_type, entity } = req.body || {};
  console.log(`[wg-webhook] event="${event}" entity_type="${entity_type}" id=${id}`);

  try {
    if (entity_type !== "Subscription") {
      console.log(`[wg-webhook] ignoriere entity_type="${entity_type}"`);
      return res.status(200).json({ ignored: true, reason: "entity_type" });
    }
    if (!REGISTRATION_EVENTS.has(event)) {
      console.log(
        `[wg-webhook] ignoriere unbekanntes event="${event}" - falls das eine ECHTE ` +
          `Neuanmeldung war, WG_REGISTRATION_EVENTS um "${event}" ergaenzen. Payload:`,
        JSON.stringify(req.body)
      );
      return res.status(200).json({ ignored: true, reason: "event" });
    }
    if (entity?.unsubscribed) {
      console.log(`[wg-webhook] ueberspringe abgemeldete subscription ${entity?.id}`);
      return res.status(200).json({ ignored: true, reason: "unsubscribed" });
    }

    const result = await processRegistration(entity);
    console.log(`[wg-webhook] ok:`, result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    await alertFailure("Verarbeitung einer WebinarGeek-Registrierung fehlgeschlagen", {
      event,
      id,
      error: err?.message,
    });
    // 500 zurueckgeben, falls WebinarGeek fehlgeschlagene Zustellungen retried.
    return res.status(500).json({ error: "processing failed" });
  }
});

// Manche Webhook-Anbieter pruefen die Erreichbarkeit vorab per GET/HEAD.
app.get("/webhooks/easy2", (_req, res) => res.status(200).json({ ok: true }));
app.head("/webhooks/easy2", (_req, res) => res.sendStatus(200));

app.post("/webhooks/easy2", async (req, res) => {
  if (!verifySignatureGeneric(req, EASY2_WEBHOOK_SECRET, "easy2-webhook")) {
    console.warn("[easy2-webhook] ungueltige/fehlende Signatur - abgelehnt.");
    return res.status(401).json({ error: "invalid signature" });
  }

  const body = req.body || {};
  // Real bestaetigt 2026-08-08: Easy2 schickt den Event-Namen NICHT im Body,
  // sondern im Header "X-Webhook-Topic" (Body enthaelt nur die Nutzlast, z.B.
  // {website, contact, formName, formValues} bei form_submitted). Body.event
  // bleibt als Fallback drin, falls Easy2 das Format je aendert.
  const event = req.get("X-Webhook-Topic") || body.event;
  // Volles Payload IMMER loggen (auch bei bekannten Events) - Webhook-Form von
  // Easy2 war bis 2026-08-08 nicht an einem echten Event verifiziert, siehe
  // lib/leadMagnet.js.
  console.log(`[easy2-webhook] event="${event}" payload:`, JSON.stringify(body));

  try {
    if (event === "form_submitted") {
      // Real bestaetigtes Payload-Format: Contact steckt unter body.contact
      // (nicht direkt im Body wie urspruenglich angenommen).
      const contact = body.contact || body.data || body;
      const results = {};

      const lists = contact.subscriberLists || contact.subscriberListIds || [];
      const isWebinarSignup = lists.some((id) => EASY2_WEBINAR_SIGNUP_LISTS.has(id));

      if (isWebinarSignup) {
        // Ersetzt "Easy2 to Webinargeek Anmeldung": registriert direkt per API
        // fuer den naechsten Termin des Haupt-Webinars, statt via Zapier. Laeuft
        // parallel zum bestehenden Zap (WebinarGeek ist bei Doppel-Registrierung
        // gleiche Email+Termin idempotent, siehe lib/webinarRegistration.js).
        if (!WEBINARGEEK_API_TOKEN) {
          console.log(`[easy2-webhook] Webinar-Anmeldung erkannt, aber WEBINARGEEK_API_TOKEN fehlt - nur geloggt:`, contact.email);
          results.webinarRegistration = { skipped: true, reason: "no WEBINARGEEK_API_TOKEN" };
        } else {
          results.webinarRegistration = await registerForNextBroadcast(contact);
          console.log(`[easy2-webhook] Webinar-Registrierung ok:`, results.webinarRegistration);
        }
      }

      results.leadMagnet = await processFormSubmitted(contact);
      console.log(`[easy2-webhook] form_submitted ok:`, results);
      return res.status(200).json({ ok: true, ...results });
    }

    if (event === "booking_created") {
      // Calls-Erstellung (naechster Schritt, noch nicht gebaut) - bewusst nur
      // loggen statt schreiben, siehe Projekt-Notiz: Closer/Qualifier-Mapping
      // erst nach echtem Payload-Abgleich verifizieren.
      console.log(`[easy2-webhook] booking_created noch nicht verarbeitet (Calls-Logik folgt) - nur geloggt.`);
      return res.status(200).json({ ignored: true, reason: "booking_created not yet implemented" });
    }

    console.log(`[easy2-webhook] ignoriere unbehandeltes event="${event}"`);
    return res.status(200).json({ ignored: true, reason: "event" });
  } catch (err) {
    await alertFailure("Verarbeitung eines Easy2-Webhooks fehlgeschlagen", {
      event,
      error: err?.message,
    });
    return res.status(500).json({ error: "processing failed" });
  }
});

/* ============================================================
   REGISTER-LEAD  (von der eigenen Landing Page shift.yogini-glow.de)
   ============================================================
   Ersetzt fuer diesen Funnel den Umweg ueber Easy2: die Landing Page nimmt
   die Anmeldung selbst entgegen und ruft diesen Endpoint direkt auf, statt
   ueber ein Easy2-Formular zu gehen. Registriert trotzdem bei WebinarGeek
   UND Easy2 (Tag), damit beide Systeme wie gewohnt befuellt bleiben - siehe
   lib/webinarRegistration.js::registerForNextBroadcast. */
app.post("/register-lead", async (req, res) => {
  if (REGISTER_LEAD_SECRET) {
    const provided = req.get("X-Internal-Secret") || "";
    if (!safeEqual(provided, REGISTER_LEAD_SECRET)) {
      console.warn("[register-lead] ungueltiges/fehlendes Secret - abgelehnt.");
      return res.status(401).json({ error: "invalid secret" });
    }
  }

  const { firstname, email, utm } = req.body || {};
  const cleanEmail = (email || "").trim();
  if (!cleanEmail) {
    return res.status(400).json({ error: "email fehlt" });
  }
  console.log(`[register-lead] Anfrage fuer ${cleanEmail}, utm:`, JSON.stringify(utm || {}));

  if (!WEBINARGEEK_API_TOKEN) {
    console.log(`[register-lead] WEBINARGEEK_API_TOKEN fehlt - nur geloggt, keine Registrierung:`, cleanEmail);
    return res.status(200).json({ skipped: true, reason: "no WEBINARGEEK_API_TOKEN" });
  }

  try {
    const result = await registerForNextBroadcast({ email: cleanEmail, name: firstname }, { utm });
    console.log(`[register-lead] ok:`, result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    await alertFailure("Registrierung ueber shift.yogini-glow.de (register-lead) fehlgeschlagen", {
      email: cleanEmail,
      error: err?.message,
    });
    // 500, damit ein Retry auf Landing-Page-Seite (falls je gebaut) erkennt, dass es fehlschlug.
    return res.status(500).json({ error: "registration failed" });
  }
});

app.listen(PORT, () => {
  console.log(`WebinarGeek-Airtable-Sync laeuft auf Port ${PORT}`);
});
