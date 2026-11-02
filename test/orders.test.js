import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseOrder, derivePaymentModel, planOrder, processOrderCreated, termKeyFromItemName, berlinDate, EXPECTED_TOTAL,
} from "../lib/orders.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/order-${n}.json`, import.meta.url)));
const o125 = fx(125), o159 = fx(159), o160 = fx(160);

const PRODUCT_BASE =
  "Feminine Balance Ausbildung,Yogini Glow Marketing-Paket,Schlüsselakteure der Hormonsynthese,Hormon Nährstoffguide," +
  "Kochbuch Hormon Balance ,Maternity Balance Ausbildung,Kochbuch Detox Küche,12 Monate Zugang zur Online-Plattform,Glow Up Tage (2 Präsenztage)";

// Deal-Stand VOR den jeweiligen Orders (aus Airtable-Stand + Notizen rekonstruiert).
const deal = (fields, id = "recDEAL") => ({ id, fields: { ...fields } });
const deal28_vor125 = () => deal({ deal_id: 28, payment_model: "einmalzahlung_2690", lead_email_text: "milenasorge@icloud.com" }, "recJ0PSMxII5Xw0gx");
const deal28_vor159 = () => deal({
  deal_id: 28, deal_stage: "bestätigt", order_date: "2026-05-27", total_amount: 2690, payment_method: "bank",
  payment_model: "individual", Payments: ["recPay1"],
}, "recJ0PSMxII5Xw0gx");
const deal65_vor160 = (pm) => deal({ deal_id: 65, ...(pm ? { payment_model: pm } : {}) }, "rec1w0nXG63HmZVdl");

test("Datum wird in Europe/Berlin umgerechnet", () => {
  assert.equal(berlinDate(o159.created), "2026-10-29");
  assert.equal(berlinDate(o160.created), "2026-10-31");
  assert.equal(berlinDate(o125.created), "2026-05-27");
  assert.equal(berlinDate(Date.parse("2026-10-31T23:30:00Z") / 1000), "2026-11-01");
});

test("Zahlungskonditionen-Items werden erkannt", () => {
  assert.equal(termKeyFromItemName("Zahlungskonditionen: Einmalzahlung"), "einmalzahlung");
  assert.equal(termKeyFromItemName("Zahlungskonditionen: Split Pay"), "split_pay");
  assert.equal(termKeyFromItemName("Zahlungskonditionen: Premium Flex Plan"), "premium_flex");
  assert.equal(termKeyFromItemName("Zahlungskonditionen: Extended Flex Plan"), "extended_flex");
  assert.equal(termKeyFromItemName("Zahlungskonditionen: individual"), "individual");
  assert.equal(termKeyFromItemName("Zahlungskonditionen: Irgendwas"), null);
  assert.equal(termKeyFromItemName("Kochbuch"), undefined);
});

test("parseOrder 160 liefert exakt die Felder, die von Hand in Deal 65 stehen", () => {
  const p = parseOrder(o160);
  assert.deepEqual(p.fields, {
    deal_stage: "bestätigt", total_amount: 1990,
    product: PRODUCT_BASE + ",Zahlungskonditionen: Einmalzahlung",
    order_date: "2026-10-31", payment_method: "bank",
    billing_street: "Josef-Schofer-Str. 10", billing_zip: "76187", billing_city: "Karlsruhe", billing_country: "DE",
    full_name: "Miranda Rose Furze",
    company_name: "",
  });
});

test("payment_model: 160 = bn_einmalzahlung_1990 (BLACK26NOV, 1990)", () => {
  assert.deepEqual(derivePaymentModel(parseOrder(o160)), { model: "bn_einmalzahlung_1990", reason: null });
});

test("payment_model: 159 (MILENA500, kein Konditionen-Item) bleibt leer", () => {
  const r = derivePaymentModel(parseOrder(o159));
  assert.equal(r.model, null);
  assert.match(r.reason, /Zahlungskonditionen/);
});

test("payment_model: 125 (Altorder ohne Konditionen-Item) bleibt leer", () => {
  assert.equal(derivePaymentModel(parseOrder(o125)).model, null);
});

test("payment_model: alle 8 Modelle aus Item + Code, Totals passen zu EXPECTED_TOTAL", () => {
  const mk = (term, surcharge, bn) => {
    const o = structuredClone(o160);
    o.items = [{ name: "Feminine Balance Ausbildung", total: 2690 }, { name: `Zahlungskonditionen: ${term}`, total: surcharge }];
    o.subTotal = 2690 + surcharge;
    if (bn) { o.discountCode = "BLACK26NOV"; o.discountType = "fixed_discount"; o.discountAmount = 700; }
    else { o.discountCode = null; o.discountType = null; o.discountAmount = 0; }
    o.total = o.subTotal - (bn ? 700 : 0);
    return derivePaymentModel(parseOrder(o)).model;
  };
  const terms = [["Einmalzahlung", 0], ["Split Pay", 50], ["Premium Flex Plan", 100], ["Extended Flex Plan", 250]];
  const std = terms.map(([t, s]) => mk(t, s, false));
  const bn = terms.map(([t, s]) => mk(t, s, true));
  assert.deepEqual(std, ["einmalzahlung_2690", "split_pay_1370x2", "premium_flex_790+5x400", "extended_flex_6x490"]);
  assert.deepEqual(bn, ["bn_einmalzahlung_1990", "bn_split_pay_1020x2", "bn_premium_flex_790+5x260", "bn_extended_flex_490+5x350"]);
  assert.equal(EXPECTED_TOTAL[bn[3]], 2240);
});

test("payment_model: Total passt nicht zum Modell -> leer + Grund", () => {
  const o = structuredClone(o160); o.total = 2090;
  const r = derivePaymentModel(parseOrder(o));
  assert.equal(r.model, null); assert.match(r.reason, /passt nicht/);
});

test("payment_model: fremder Rabattcode / individual -> leer", () => {
  const o = structuredClone(o160); o.discountCode = "YVONNE";
  assert.match(derivePaymentModel(parseOrder(o)).reason, /kein bekanntes Aktionsmodell/);
  const i = structuredClone(o160); i.items[i.items.length - 1].name = "Zahlungskonditionen: individual";
  assert.match(derivePaymentModel(parseOrder(i)).reason, /individual/);
});

test("Order 160 / Deal 65 (leer, noch ohne order_date): update inkl. payment_model", () => {
  const plan = planOrder(parseOrder(o160), [deal65_vor160(null)]);
  assert.equal(plan.action, "update");
  assert.equal(plan.writes.payment_model, "bn_einmalzahlung_1990");
  assert.equal(plan.writes.total_amount, 1990);
  assert.equal(plan.writes.order_date, "2026-10-31");
  assert.equal(plan.writes.deal_stage, "bestätigt");
  assert.equal("company_name" in plan.writes, false);
  assert.deepEqual(plan.warnings, []);
});

test("Order 160: Closer hat payment_model schon gesetzt (Normalfall) -> bleibt, kein Overwrite", () => {
  const plan = planOrder(parseOrder(o160), [deal65_vor160("bn_einmalzahlung_1990")]);
  assert.equal(plan.action, "update");
  assert.equal("payment_model" in plan.writes, false);
  assert.deepEqual(plan.warnings, []);
});

test("Order 160: Closer-Modell weicht von Easy2 ab -> Warnung, Deal-Wert bleibt", () => {
  const plan = planOrder(parseOrder(o160), [deal65_vor160("bn_split_pay_1020x2")]);
  assert.equal(plan.action, "update");
  assert.equal("payment_model" in plan.writes, false);
  assert.match(plan.warnings[0], /weicht von der Bestellung ab/);
});

test("Order 159 (Zweitbestellung Milena) darf Deal 28 NICHT ueberschreiben", () => {
  const plan = planOrder(parseOrder(o159), [deal28_vor159()]);
  assert.equal(plan.action, "blocked");
  assert.equal(plan.writes, undefined);
  assert.match(plan.warnings[0], /NICHT uebernommen/);
  assert.match(plan.warnings[0], /Deal 28/);
  assert.equal(plan.noteWrites[0].dealRecordId, "recJ0PSMxII5Xw0gx");
});

test("Order 125 (Erstbestellung Milena) wird auf Deal 28 geschrieben", () => {
  const plan = planOrder(parseOrder(o125), [deal28_vor125()]);
  assert.equal(plan.action, "update");
  assert.equal(plan.writes.total_amount, 2690);
  assert.equal(plan.writes.order_date, "2026-05-27");
  assert.equal(plan.writes.payment_method, "bank");
  assert.equal(plan.writes.billing_city, "Bad Wildungen");
});

test("Redelivery: Deal hat order_date+total dieser Order schon -> already_applied, keine Warnung", () => {
  const d = deal({ deal_id: 65, order_date: "2026-10-31", total_amount: 1990, Payments: ["recP"] });
  const plan = planOrder(parseOrder(o160), [d]);
  assert.equal(plan.action, "already_applied");
  assert.deepEqual(plan.warnings, []);
});

test("Kein Deal / mehrere offene Deals / stornierter Deal -> kein Write, Warnung", () => {
  assert.equal(planOrder(parseOrder(o160), []).action, "no_deal");
  const two = [deal({ deal_id: 1 }, "r1"), deal({ deal_id: 2 }, "r2")];
  assert.equal(planOrder(parseOrder(o160), two).action, "ambiguous");
  const dead = planOrder(parseOrder(o160), [deal({ deal_id: 3, deal_stage: "storniert" })]);
  assert.equal(dead.action, "blocked");
});

test("Order nicht completed -> skip", () => {
  const o = structuredClone(o160); o.status = "cancelled";
  assert.equal(planOrder(parseOrder(o), [deal65_vor160(null)]).action, "skip");
});

// ---- processOrderCreated: Shadow schreibt nichts, live schreibt ----
function mkDeps(deals) {
  const calls = { updates: [], alerts: [], fetched: [] };
  return {
    calls,
    deps: {
      findDealsByEmail: async () => deals,
      updateDeal: async (id, f) => calls.updates.push([id, f]),
      fetchOrder: async (id) => { calls.fetched.push(id); return o160; },
      alert: async (m, d) => calls.alerts.push([m, d]),
    },
  };
}
const quiet = { log() {}, warn() {}, error() {} };

test("shadow: schreibt nie, auch nicht im blocked-Fall", async () => {
  for (const [order, deals] of [[o160, [deal65_vor160(null)]], [o159, [deal28_vor159()]]]) {
    const { deps, calls } = mkDeps(deals);
    const r = await processOrderCreated({ order }, { mode: "shadow", deps, log: quiet });
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.alerts.length, 0);
    assert.equal(r.mode, "shadow");
  }
});

test("shadow: diffVsCurrentDeal zeigt, was sich aendern wuerde", async () => {
  const { deps } = mkDeps([deal65_vor160("bn_einmalzahlung_1990")]);
  const r = await processOrderCreated({ order: o160 }, { mode: "shadow", deps, log: quiet });
  assert.equal(r.diffVsCurrentDeal.total_amount.would_write, 1990);
  assert.equal(r.diffVsCurrentDeal.total_amount.current, null);
});

test("unbekannter Modus faellt auf shadow zurueck (nie versehentlich live)", async () => {
  const { deps, calls } = mkDeps([deal65_vor160(null)]);
  await processOrderCreated({ order: o160 }, { mode: "lvie", deps, log: quiet });
  assert.equal(calls.updates.length, 0);
});

test("off: tut nichts", async () => {
  const { deps, calls } = mkDeps([deal65_vor160(null)]);
  const r = await processOrderCreated({ order: o160 }, { mode: "off", deps, log: quiet });
  assert.equal(r.skipped, true); assert.equal(calls.updates.length, 0);
});

test("live: update schreibt genau einen PATCH mit den Plan-Feldern", async () => {
  const { deps, calls } = mkDeps([deal65_vor160(null)]);
  await processOrderCreated({ order: o160 }, { mode: "live", deps, log: quiet });
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0][0], "rec1w0nXG63HmZVdl");
  assert.equal(calls.updates[0][1].payment_model, "bn_einmalzahlung_1990");
  assert.equal(calls.alerts.length, 0);
});

test("live: Zweitbestellung -> nur payment_note + Alert, order_date/total unveraendert", async () => {
  const d = deal28_vor159(); d.fields.payment_note = "alte Notiz";
  const { deps, calls } = mkDeps([d]);
  await processOrderCreated({ order: o159 }, { mode: "live", deps, log: quiet });
  assert.equal(calls.updates.length, 1);
  const [, f] = calls.updates[0];
  assert.deepEqual(Object.keys(f), ["payment_note"]);
  assert.match(f.payment_note, /NICHT uebernommen/);
  assert.match(f.payment_note, /alte Notiz$/);
  assert.equal(calls.alerts.length, 1);
});

test("Payload ohne items -> Order wird per API nachgeladen; kaputter Payload wirft", async () => {
  const { deps, calls } = mkDeps([deal65_vor160(null)]);
  await processOrderCreated({ order: { id: 160 } }, { mode: "shadow", deps, log: quiet });
  assert.deepEqual(calls.fetched, [160]);
  await assert.rejects(processOrderCreated({ foo: 1 }, { mode: "shadow", deps: { ...deps, fetchOrder: undefined }, log: quiet }));
});
