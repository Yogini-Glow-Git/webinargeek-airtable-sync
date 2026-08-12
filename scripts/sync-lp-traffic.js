/* ============================================================
   Taeglicher Sync: shift.yogini-glow.de-Analytics -> Airtable LP_Traffic_Daily.
   Holt die KPIs eines Kalendertags (Default: gestern) vom /api/stats-sync-
   Endpoint der Landing Page (maschinenlesbar, Shared Secret statt Login) und
   schreibt/aktualisiert genau EINEN Airtable-Datensatz fuer diesen Tag.

   Aufruf: node scripts/sync-lp-traffic.js [YYYY-MM-DD]
   Env: LP_STATS_URL (Default https://shift.yogini-glow.de), STATS_SYNC_SECRET,
        AIRTABLE_TOKEN, AIRTABLE_BASE_ID (bereits vorhanden fuer den Hauptservice).

   Gedacht fuer einen taeglichen Coolify-Scheduled-Task (z.B. 03:00 Uhr, nachdem
   der Vortag komplett vorbei ist).
   ============================================================ */

const AIRTABLE_API = "https://api.airtable.com/v0";
const TABLE = "LP_Traffic_Daily";

function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" };
}

async function findDailyRecord(day) {
  const formula = `IS_SAME({date}, '${day}', 'day')`;
  const url = `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await fetch(url, { headers: airtableHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(`Airtable GET ${TABLE} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data.records?.[0] || null;
}

async function upsertDailyRecord(day, fields) {
  const existing = await findDailyRecord(day);
  const url = existing
    ? `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}/${existing.id}`
    : `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`;
  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: { date: day, ...fields }, typecast: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Airtable ${existing ? "PATCH" : "POST"} ${TABLE} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  return { action: existing ? "updated" : "created", id: data.id };
}

function pctBreakdown(countsObj) {
  const total = Object.values(countsObj).reduce((s, n) => s + n, 0);
  const entries = Object.entries(countsObj).sort((a, b) => b[1] - a[1]);
  return { total, entries, pct: (n) => (total ? Math.round((n / total) * 1000) / 10 : 0) };
}

async function main() {
  const day =
    process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])
      ? process.argv[2]
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const lpBase = process.env.LP_STATS_URL || "https://shift.yogini-glow.de";
  if (!process.env.STATS_SYNC_SECRET) throw new Error("STATS_SYNC_SECRET fehlt in der Umgebung.");
  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error("AIRTABLE_TOKEN/AIRTABLE_BASE_ID fehlen.");

  const res = await fetch(`${lpBase}/api/stats-sync?date=${day}`, {
    headers: { "X-Sync-Secret": process.env.STATS_SYNC_SECRET },
  });
  const stats = await res.json();
  if (!res.ok) throw new Error(`LP /api/stats-sync -> HTTP ${res.status}: ${JSON.stringify(stats)}`);

  const devices = pctBreakdown(stats.devices || {});
  const sources = pctBreakdown(stats.sources || {});

  const fields = {
    pageviews: stats.totals.pageviews,
    visitors: stats.totals.visitors,
    leads_lp: stats.totals.leads,
    conversion_rate: stats.totals.visitors ? stats.totals.leads / stats.totals.visitors : 0, // Airtable-Percent: 0..1
    device_desktop_pct: devices.pct(devices.entries.find(([k]) => k === "desktop")?.[1] || 0) / 100,
    device_mobile_pct: devices.pct(devices.entries.find(([k]) => k === "mobile")?.[1] || 0) / 100,
    device_tablet_pct: devices.pct(devices.entries.find(([k]) => k === "tablet")?.[1] || 0) / 100,
    top_source: sources.entries[0]?.[0] || "",
    sources_breakdown: sources.entries.map(([k, n]) => `${k}: ${n} (${sources.pct(n)}%)`).join("\n"),
    synced_at: new Date().toISOString(),
  };

  const result = await upsertDailyRecord(day, fields);
  console.log(`[sync-lp-traffic] ${day}: ${result.action} ${result.id} - pv=${fields.pageviews} vis=${fields.visitors} leads=${fields.leads_lp}`);
}

main().catch((err) => {
  console.error("[sync-lp-traffic] FEHLER:", err.message);
  process.exit(1);
});
