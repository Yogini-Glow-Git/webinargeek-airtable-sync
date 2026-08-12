import { findAllByField, getRecord, updateRecord } from "./airtable.js";

const LEADS = "Leads";

function linkIdsOf(fieldValue) {
  return (fieldValue || []).map((r) => (typeof r === "string" ? r : r.id));
}

/**
 * Verlinkt einen Lead bidirektional (Feld `duplicate_leads`) mit allen anderen
 * Leads, die dieselbe Email haben - typischerweise WebinarGeek-Funnel +
 * Easy2-Direktfunnel fuer dieselbe Person (siehe Kundensuche-Duplikat-Fix,
 * 2026-08-12).
 *
 * Verhindert NICHT das Anlegen des zweiten Leads - das ist by design, jede
 * Anmeldung ist ein eigenes Funnel-Event (siehe lead_id-Konvention in
 * registration.js/leadMagnet.js). Macht das Duplikat aber sofort im Airtable
 * sichtbar (Lookup-Feld in Calls -> Kundensuche-Interface), statt erst beim
 * naechsten manuellen Abgleich.
 */
export async function linkDuplicateLeadsByEmail(leadRecordId, email) {
  const emailLower = (email || "").trim().toLowerCase();
  if (!emailLower) return { linked: 0 };

  const matches = await findAllByField(LEADS, "email", emailLower, 25);
  const others = matches.filter((r) => r.id !== leadRecordId);
  if (others.length === 0) return { linked: 0 };

  const otherIds = others.map((r) => r.id);

  // eigene Seite: bestehende Links behalten + neue ergaenzen, keine Duplikate in der Liste
  const self = await getRecord(LEADS, leadRecordId);
  const selfExisting = linkIdsOf(self.fields?.duplicate_leads);
  const selfNext = Array.from(new Set([...selfExisting, ...otherIds]));
  await updateRecord(LEADS, leadRecordId, { duplicate_leads: selfNext });

  // andere Seite: jeweils nur den neuen Lead ergaenzen, Rest unangetastet
  for (const other of others) {
    const otherExisting = linkIdsOf(other.fields?.duplicate_leads);
    if (!otherExisting.includes(leadRecordId)) {
      await updateRecord(LEADS, other.id, { duplicate_leads: [...otherExisting, leadRecordId] });
    }
  }

  return { linked: others.length, otherLeadIds: otherIds };
}
