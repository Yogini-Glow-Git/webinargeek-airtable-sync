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
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

function verifySignature(req) {
  if (!WEBINARGEEK_WEBHOOK_SECRET) return true; // s.o. - bewusst nur fuer lokales Testen
  const signature = req.get("Signature") || req.get("signature");
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", WEBINARGEEK_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
