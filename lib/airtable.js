const AIRTABLE_API = "https://api.airtable.com/v0";

function baseUrl(table) {
  return `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function airtableFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Airtable ${options.method || "GET"} ${url} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Airtable-Formel-Strings: einfache Anfuehrungszeichen und Backslashes escapen.
function escapeFormulaValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function findOneByField(table, field, value) {
  const formula = `{${field}} = '${escapeFormulaValue(value)}'`;
  const url = `${baseUrl(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const data = await airtableFetch(url);
  return data.records?.[0] || null;
}

/** Wie findOneByField, aber gibt alle Treffer zurueck (z.B. fuer Duplikat-Checks). */
export async function findAllByField(table, field, value, maxRecords = 25) {
  const formula = `{${field}} = '${escapeFormulaValue(value)}'`;
  const url = `${baseUrl(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${maxRecords}`;
  const data = await airtableFetch(url);
  return data.records || [];
}

export async function getRecord(table, recordId) {
  return airtableFetch(`${baseUrl(table)}/${recordId}`);
}

export async function createRecord(table, fields) {
  return airtableFetch(baseUrl(table), {
    method: "POST",
    body: JSON.stringify({ fields, typecast: true }),
  });
}

export async function updateRecord(table, recordId, fields) {
  return airtableFetch(`${baseUrl(table)}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });
}

/** Findet einen Datensatz per Feld+Wert, legt ihn sonst mit defaultFields an. */
export async function findOrCreate(table, field, value, defaultFields = {}) {
  const existing = await findOneByField(table, field, value);
  if (existing) return existing;
  return createRecord(table, { [field]: value, ...defaultFields });
}
