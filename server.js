import express from "express";
import crypto from "node:crypto";
import { processRegistration } from "./lib/registration.js";
import { alertFailure } from "./lib/alert.js";

const {
  PORT = 3000,
  WEBINARGEEK_WEBHOOK_SECRET,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
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

function computeHex(body) {
  return crypto.createHmac("sha256", WEBINARGEEK_WEBHOOK_SECRET).update(body).digest("hex");
}
function computeBase64(body) {
  return crypto.createHmac("sha256", WEBINARGEEK_WEBHOOK_SECRET).update(body).digest("base64");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Liefert true/false, und loggt bei Fehlschlag ALLE Header + die selbst berechneten
// Signaturen (hex/base64/mit "sha256="-Praefix) zum Abgleich - bis der exakte
// Header-Name und das Format von WebinarGeek einmal real bestaetigt sind.
function verifySignature(req) {
  if (!WEBINARGEEK_WEBHOOK_SECRET) return true; // s.o. - bewusst nur fuer lokales Testen

  const candidates = [
    req.get("Signature"),
    req.get("X-Webinargeek-Signature"),
    req.get("X-Signature"),
    req.get("X-Hub-Signature-256"),
    req.get("X-Hub-Signature"),
  ].filter(Boolean);

  const hex = computeHex(req.rawBody);
  const base64 = computeBase64(req.rawBody);
  const validValues = new Set([hex, base64, `sha256=${hex}`, `sha256=${base64}`]);

  const matched = candidates.some((c) => [...validValues].some((v) => v.length === c.length && safeEqual(v, c)));

  if (!matched) {
    console.warn("[wg-webhook] Signatur-Check fehlgeschlagen. Alle Header:", JSON.stringify(req.headers));
    console.warn("[wg-webhook] erwartet hex:", hex, "| base64:", base64);
  }
  return matched;
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

app.listen(PORT, () => {
  console.log(`WebinarGeek-Airtable-Sync laeuft auf Port ${PORT}`);
});
