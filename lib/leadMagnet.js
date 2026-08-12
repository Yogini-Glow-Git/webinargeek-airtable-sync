import { findOneByField, updateRecord, createRecord } from "./airtable.js";
import { linkDuplicateLeadsByEmail } from "./duplicates.js";

const LEADS = "Leads";

// Easy2-Subscriber-List-Id -> lead_magnet-Option in Airtable.
// WICHTIG: die Liste "YogaReport" hat NICHT die Id aus dem alten Zapier-Wiki
// (110963178, das ist live tatsaechlich "1. Bewerbungsgespraech nach Webinar"),
// sondern 105659590 ("9. LM-Yoga Markt Report") - per GET /api/site/contacts
// live gegen einen echten YogaReport-Kontakt geprueft am 2026-08-08. Nur
// verifizierte Zuordnungen hier eintragen; unbekannte List-Ids werden bewusst
// NICHT geschrieben, sondern nur laut geloggt (siehe processFormSubmitted).
export const LIST_LEAD_MAGNET_MAP = {
  178254506: "ausbildungsbroschuere", // "7. Ausbildungsbroschuere+LM"
  105659590: "yoga_report", // "9. LM-Yoga Markt Report"
};

function splitName(fullName) {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { first: "", last: "" };
  const parts = trimmed.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function propsToMap(properties) {
  const map = {};
  for (const p of properties || []) {
    if (p?.name) map[p.name] = p.value ?? "";
  }
  return map;
}

/**
 * Bildet die Easy2-Direct-Lead-Zaps nach (siehe wiki/sources/easy2-direct-funnel.md):
 * "Easy2 yogareport+LM -> Airtable Lead" + "Easy2 Warteliste+LM -> Airtable Lead".
 * lead_id = easy2_{email} (kein Datum, ein Lead pro Mail). funnel_type=easy2_direct,
 * lead_magnet je Liste, UTMs direkt aus Easy2 (kein Campaign-Link fuer diesen Funnel,
 * anders als beim Webinar-Funnel).
 *
 * `contact` ist das Easy2-Contact-Objekt aus dem Webhook-Payload - Form (laut
 * GET /api/site/contacts live verifiziert): { id, name, email, phone, properties:
 * [{name,value}], tags: [...], subscriberLists: [id,...] }. Webhook-Form ist NICHT
 * final verifiziert (kein echtes Event bisher durchgelaufen) - deshalb wird das volle
 * Payload IMMER geloggt, und bei unerwarteter Form wird nichts geschrieben statt
 * geraten.
 */
export async function processFormSubmitted(contact) {
  const email = (contact?.email || "").trim().toLowerCase();
  if (!email) {
    return { skipped: true, reason: "keine email im Payload" };
  }

  const lists = contact.subscriberLists || contact.subscriberListIds || [];
  const matchedListId = lists.find((id) => LIST_LEAD_MAGNET_MAP[id] != null);
  if (matchedListId == null) {
    // Keine bekannte LM-Liste getroffen - bewusst NICHT schreiben (koennte ein
    // Newsletter-Signup o.ae. sein, das nicht als Lead gilt). Laut loggen, damit
    // sich neue/unbekannte List-Ids (z.B. Warteliste) hier ergaenzen lassen.
    return { skipped: true, reason: "keine bekannte LM-Liste in subscriberLists", lists };
  }
  const leadMagnet = LIST_LEAD_MAGNET_MAP[matchedListId];

  const { first, last } = splitName(contact.name);
  const props = propsToMap(contact.properties);

  const leadId = `easy2_${email}`;
  const leadFields = {
    lead_id: leadId,
    email,
    first_name: first,
    last_name: last,
    phone: contact.phone || "",
    funnel_type: "easy2_direct",
    lead_magnet: leadMagnet,
    utm_source: props.utm_source || "direct",
    utm_medium: props.utm_medium || "none",
    utm_campaign: props.utm_campaign || "direct-organic",
    utm_content: props.utm_content || "",
    utm_term: props.utm_term || "",
  };

  const existing = await findOneByField(LEADS, "lead_id", leadId);
  let recordId, action;
  if (existing) {
    // registered_at nur beim ERSTEN Anlegen setzen (Pflichtfeld fuer Attribution,
    // siehe wiki/entities/entities-leads.md) - bei Updates nicht überschreiben,
    // sonst verschiebt ein zweiter LM-Download den Anmeldezeitpunkt.
    await updateRecord(LEADS, existing.id, leadFields);
    recordId = existing.id;
    action = "updated";
  } else {
    const created = await createRecord(LEADS, {
      ...leadFields,
      registered_at: new Date().toISOString(),
    });
    recordId = created.id;
    action = "created";
  }

  // Cross-Funnel-Duplikat-Check (z.B. schon ein WebinarGeek-Lead mit derselben
  // Email vorhanden, wie bei Sandra Breitenmoser) - verhindert den zweiten Lead
  // nicht, verlinkt ihn aber sofort sichtbar, siehe lib/duplicates.js.
  const dup = await linkDuplicateLeadsByEmail(recordId, email);

  return { action, leadId, recordId, leadMagnet, duplicateLeadsLinked: dup.linked };
}
