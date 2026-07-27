import { findOneByField, findOrCreate, createRecord, updateRecord } from "./airtable.js";

const LEADS = "Leads";
const WEBINARS = "Webinars";
const CAMPAIGNS = "Campaigns";

function toISODate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
}

function toISODateTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Bildet exakt die Logik des bisherigen Zaps "WebinarGeek Registration -> Leads" nach
 * (siehe wiki/workflows/workflows-zaps.md): dyn. wg_id, UTM-Fallback (direct/none/
 * direct-organic), Campaign- und Webinar-Find-or-Create, Lead-Upsert auf lead_id.
 *
 * `sub` ist das Subscription-Objekt aus dem WebinarGeek-Webhook (entity), das laut
 * WebinarGeek-API dieselbe Form hat wie GET /subscriptions/{id}: enthaelt firstname,
 * surname, email, phone, created_at sowie verschachtelte webinar/episode/broadcast-Objekte.
 */
export async function processRegistration(sub) {
  const webinarId = sub.webinar?.id;
  const webinarTitle = sub.webinar?.title || sub.episode?.title || "Unbekanntes Webinar";
  const broadcastDate = sub.broadcast?.date;

  if (!webinarId || !broadcastDate) {
    throw new Error(
      `subscription ${sub.id ?? "?"} hat kein webinar.id/broadcast.date im Payload - kann lead_id nicht bauen. ` +
        `Payload-Form pruefen (evtl. Follow-up-Call auf GET /subscriptions/{id} noetig).`
    );
  }

  const email = (sub.email || "").trim();
  if (!email) {
    throw new Error(`subscription ${sub.id ?? "?"} hat keine E-Mail - uebersprungen.`);
  }
  const emailLower = email.toLowerCase();
  const dateStr = toISODate(broadcastDate);

  const wgWebinarId = `${webinarId}_${dateStr}`;
  const leadId = `${webinarId}_${dateStr}_${emailLower}`;

  // 1. Webinar find-or-create (entspricht Zap-Schritt 4)
  const webinarRecord = await findOrCreate(WEBINARS, "webinar_id", wgWebinarId, {
    title: webinarTitle,
    date: dateStr,
    format: "live",
  });

  // 2. UTM-Fallback: extra_fields ist bei WebinarGeek-Registrierungen praktisch immer leer
  // (UTMs werden aktuell nicht von Easy2 durchgereicht) -> Defaults wie im Original-Zap.
  const utmSource = sub.extra_fields?.utm_source || "direct";
  const utmMedium = sub.extra_fields?.utm_medium || "none";
  const utmCampaign = sub.extra_fields?.utm_campaign || "direct-organic";
  const utmContent = sub.extra_fields?.utm_content || "";
  const utmTerm = sub.extra_fields?.utm_term || "";

  // 3. Campaign find-or-create (entspricht Zap-Schritt 3)
  const campaignRecord = await findOrCreate(CAMPAIGNS, "utm_campaign", utmCampaign, {
    campaign_id: `camp-${utmCampaign}`,
    name: utmCampaign,
    channel: "unknown",
    status: "active",
  });

  // 4. Lead upsert auf lead_id (entspricht Zap-Schritt 5)
  const leadFields = {
    lead_id: leadId,
    email,
    first_name: sub.firstname || "",
    last_name: sub.surname || "",
    phone: sub.phone || "",
    registered_at: toISODateTime(sub.created_at ?? Math.floor(Date.now() / 1000)),
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    utm_content: utmContent,
    utm_term: utmTerm,
    webinar: [webinarRecord.id],
    campaign: [campaignRecord.id],
  };

  const existingLead = await findOneByField(LEADS, "lead_id", leadId);
  if (existingLead) {
    await updateRecord(LEADS, existingLead.id, leadFields);
    return { action: "updated", leadId, recordId: existingLead.id };
  }
  const created = await createRecord(LEADS, leadFields);
  return { action: "created", leadId, recordId: created.id };
}
