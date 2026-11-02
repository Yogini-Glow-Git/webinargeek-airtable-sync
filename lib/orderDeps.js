import { findAllByField, updateRecord } from "./airtable.js";
import { alertFailure } from "./alert.js";
import { DEAL_TABLE } from "./orders.js";

const EASY2_API = "https://yogini-glow.easy2.de/api/site";

/**
 * Deals zu einer E-Mail. lead_email_text ist ein ARRAYJOIN-Lookup (kann Gross-/
 * Kleinschreibung und mehrere Mails enthalten) -> grob per FIND filtern, dann in
 * JS exakt pruefen, damit "a@x.de" nicht "ba@x.de" trifft.
 */
export async function findDealsByEmail(email) {
  const e = email.toLowerCase();
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(DEAL_TABLE)}`;
  const safe = e.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const formula = `FIND('${safe}', LOWER({lead_email_text}))`;
  const res = await fetch(`${url}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=25`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Airtable GET Deals -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  return (data.records || []).filter((r) =>
    String(r.fields.lead_email_text || "")
      .toLowerCase()
      .split(/[,;\s]+/)
      .includes(e)
  );
}

export async function updateDeal(recordId, fields) {
  return updateRecord(DEAL_TABLE, recordId, fields);
}

export async function fetchOrder(id) {
  if (!process.env.EASY2_API_KEY) throw new Error("EASY2_API_KEY fehlt - kann Order nicht nachladen");
  const res = await fetch(`${EASY2_API}/orders/${id}`, {
    headers: { Authorization: `Bearer ${process.env.EASY2_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Easy2 GET orders/${id} -> HTTP ${res.status}`);
  return res.json();
}

export const orderDeps = { findDealsByEmail, updateDeal, fetchOrder, alert: alertFailure };
