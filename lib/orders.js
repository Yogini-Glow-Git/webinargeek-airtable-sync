// Easy2 `order_created` -> Airtable Deals. Ersetzt den Zap "Easy2 New Order -> Deals".
//
// Zwei Schichten, damit alles ohne Netzwerk testbar ist:
//   - reine Funktionen: parseOrder, derivePaymentModel, planOrder (keine I/O)
//   - processOrderCreated: Orchestrierung mit injizierbaren Airtable-Funktionen
//
// MODUS (env EASY2_ORDERS_MODE): "off" | "shadow" (Default) | "live"
//   shadow: liest Airtable (GET), loggt pro Order EINE JSON-Zeile "[order-shadow] ...",
//           schreibt NICHTS. Laeuft parallel zum Zap.
//   live:   schreibt wirklich. Erst nach ausdruecklicher Freigabe setzen.
//
// Was der Zap falsch gemacht hat und wie das hier geloest ist (belegt 2026-10-29/31):
//   1) Zweitbestellung ueberschrieb den Altdeal (Milena Sorge, Deal 28).
//      -> Es wird nur ein Deal beschrieben, der KEIN order_date und KEINE Payments hat.
//         Sonst: nichts ueberschreiben, laute Warnung (Log + payment_note am Deal).
//   2) Deal 65 (Order 160) wurde gar nicht befuellt, ohne dass es jemand merkte.
//      -> Jedes Ergebnis ausser "updated"/"already_applied" ist ein WARN-/Fehler-Log
//         (live zusaetzlich alertFailure), Exceptions werden als 500 gemeldet.
//   3) payment_model aus dem Easy2-Item "Zahlungskonditionen: ..." + Rabattcode ableiten.

export const DEAL_TABLE = "Deals";

export const BN_CODE = "BLACK26NOV";
export const BN_DISCOUNT = 700;

// Soll-Totals je payment_model (identisch zu MODELS in payment-script-v3.3.js).
export const EXPECTED_TOTAL = {
  "einmalzahlung_2690": 2690,
  "split_pay_1370x2": 2740,
  "premium_flex_790+5x400": 2790,
  "extended_flex_6x490": 2940,
  "bn_einmalzahlung_1990": 1990,
  "bn_split_pay_1020x2": 2040,
  "bn_premium_flex_790+5x260": 2090,
  "bn_extended_flex_490+5x350": 2240,
};

// Zahlungskonditionen-Schluessel -> [Standard-Modell, Black-November-Modell]
const TERMS = {
  einmalzahlung: ["einmalzahlung_2690", "bn_einmalzahlung_1990"],
  split_pay: ["split_pay_1370x2", "bn_split_pay_1020x2"],
  premium_flex: ["premium_flex_790+5x400", "bn_premium_flex_790+5x260"],
  extended_flex: ["extended_flex_6x490", "bn_extended_flex_490+5x350"],
};

/** "Zahlungskonditionen: Premium Flex Plan" -> "premium_flex" | "individual" | null (unbekannt). */
export function termKeyFromItemName(name) {
  const m = /^\s*Zahlungskonditionen\s*:\s*(.+?)\s*$/i.exec(name || "");
  if (!m) return undefined; // kein Zahlungskonditionen-Item
  const t = m[1].toLowerCase();
  if (t.includes("individual")) return "individual";
  if (t.includes("einmal")) return "einmalzahlung";
  if (t.includes("split")) return "split_pay";
  if (t.includes("premium")) return "premium_flex";
  if (t.includes("extended")) return "extended_flex";
  return null;
}

/** Unix-Sekunden -> YYYY-MM-DD in Europe/Berlin (wie die Zap-Datumsumrechnung). */
export function berlinDate(unixSeconds) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

/**
 * Easy2-Order -> die Werte, die der Zap geschrieben hat (gleiches Format, damit
 * Shadow-Vergleich und Fixture-Tests 1:1 gegen den Zap-Output laufen).
 * `product` bewusst unveraendert wie vom Zap: Namen ungetrimmt, mit "," verbunden.
 */
export function parseOrder(order) {
  const bill = order.billingAddress || {};
  const street = [bill.address, bill.address2].map((s) => (s || "").trim()).filter(Boolean).join(" ");
  return {
    orderId: order.id,
    status: order.status,
    email: (order.customerEmail || "").trim().toLowerCase(),
    total: order.total,
    subTotal: order.subTotal,
    discountCode: order.discountCode || null,
    discountType: order.discountType || null,
    discountAmount: order.discountAmount || 0,
    paymentMethod: (order.paymentMethod || "").toLowerCase(),
    orderDate: order.created ? berlinDate(order.created) : null,
    itemNames: (order.items || []).map((i) => i.name),
    fields: {
      deal_stage: "bestätigt",
      total_amount: order.total,
      product: (order.items || []).map((i) => i.name).join(","),
      order_date: order.created ? berlinDate(order.created) : null,
      payment_method: (order.paymentMethod || "").toLowerCase(),
      billing_street: street,
      billing_zip: (bill.zipCode || "").trim(),
      billing_city: (bill.city || "").trim(),
      billing_country: (bill.country || "").trim(),
      company_name: (bill.companyName || "").trim(),
      full_name: (order.customerName || "").trim(),
    },
  };
}

/**
 * payment_model aus der Order ableiten. Gibt { model, reason } zurueck; model ist
 * null, wenn es nicht eindeutig ist (dann entscheidet der Closer, `reason` erklaert warum).
 */
export function derivePaymentModel(parsed) {
  const termItems = parsed.itemNames.map(termKeyFromItemName).filter((t) => t !== undefined);
  if (termItems.length === 0) {
    return { model: null, reason: 'kein Item "Zahlungskonditionen: ..." in der Order' };
  }
  if (new Set(termItems).size > 1) {
    return { model: null, reason: "mehrere widerspruechliche Zahlungskonditionen-Items" };
  }
  const term = termItems[0];
  if (term === "individual") {
    return { model: null, reason: "Zahlungskonditionen = individual (Raten legt der Closer von Hand an)" };
  }
  if (term === null) {
    return { model: null, reason: "unbekannte Zahlungskonditionen-Bezeichnung" };
  }

  const [standard, bn] = TERMS[term];
  let model;
  if (parsed.discountCode == null && !parsed.discountAmount) {
    model = standard;
  } else if (
    String(parsed.discountCode).toUpperCase() === BN_CODE &&
    parsed.discountType === "fixed_discount" &&
    parsed.discountAmount === BN_DISCOUNT
  ) {
    model = bn;
  } else {
    return {
      model: null,
      reason: `Rabattcode "${parsed.discountCode}" (${parsed.discountAmount} EUR) ist kein bekanntes Aktionsmodell`,
    };
  }

  if (parsed.total !== EXPECTED_TOTAL[model]) {
    return {
      model: null,
      reason: `Total ${parsed.total} EUR passt nicht zu ${model} (Soll ${EXPECTED_TOTAL[model]} EUR)`,
    };
  }
  return { model, reason: null };
}

const sameMoney = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

function isDeadDeal(f) {
  return f.deal_stage === "storniert" || f.status === "refunded" || f.status === "cancelled";
}

/**
 * Entscheidung ohne I/O. `deals` = Airtable-Records ({id, fields}) mit passender E-Mail.
 * Rueckgabe: { action, dealRecordId?, writes?, noteWrites?, warnings[], paymentModel }
 *  action: "update" | "already_applied" | "no_deal" | "blocked" | "ambiguous" | "skip"
 */
export function planOrder(parsed, deals) {
  const warnings = [];
  const pm = derivePaymentModel(parsed);
  const base = { orderId: parsed.orderId, email: parsed.email, paymentModel: pm, warnings };

  if (!parsed.email) {
    return { ...base, action: "skip", warnings: [...warnings, "Order ohne customerEmail"] };
  }
  if (parsed.status && parsed.status !== "completed") {
    return { ...base, action: "skip", warnings: [...warnings, `Order-Status "${parsed.status}" (nicht completed) - ignoriert`] };
  }
  if (!parsed.orderDate || typeof parsed.total !== "number") {
    return { ...base, action: "skip", warnings: [...warnings, "Order ohne Datum oder Total"] };
  }

  // Idempotenz: Webhook-Redelivery (oder der Zap war schneller und hat dasselbe geschrieben).
  const applied = deals.find(
    (d) => d.fields.order_date === parsed.orderDate && sameMoney(d.fields.total_amount, parsed.total)
  );
  if (applied) {
    return { ...base, action: "already_applied", dealRecordId: applied.id };
  }

  if (deals.length === 0) {
    warnings.push(
      `Kein Deal mit lead_email_text = ${parsed.email} gefunden (Easy2-Order ${parsed.orderId}). ` +
        "Bestellung mit anderer E-Mail als der Lead? Deal von Hand befuellen."
    );
    return { ...base, action: "no_deal" };
  }

  const eligible = deals.filter(
    (d) => !d.fields.order_date && !(d.fields.Payments && d.fields.Payments.length) && !isDeadDeal(d.fields)
  );

  if (eligible.length === 0) {
    const d = deals[0];
    const why = deals
      .map((x) => {
        const bits = [];
        if (x.fields.order_date) bits.push(`order_date ${x.fields.order_date}`);
        if (x.fields.Payments?.length) bits.push(`${x.fields.Payments.length} Payment(s)`);
        if (isDeadDeal(x.fields)) bits.push("storniert/verworfen");
        return `Deal ${x.fields.deal_id ?? x.id} (${bits.join(", ")})`;
      })
      .join("; ");
    const msg =
      `Easy2-Bestellung ${parsed.orderId} vom ${parsed.orderDate} (${parsed.total} EUR, ${parsed.paymentMethod || "?"}` +
      `${parsed.discountCode ? ", Code " + parsed.discountCode : ""}) NICHT uebernommen: ${why} ist schon abgerechnet. ` +
      "Zweitbestellung/Restzahlung? Von Hand zuordnen.";
    warnings.push(msg);
    return {
      ...base,
      action: "blocked",
      dealRecordId: d.id,
      noteWrites: deals.map((x) => ({ dealRecordId: x.id, note: `⚠ ${msg}`, existingNote: x.fields.payment_note || "" })),
    };
  }

  if (eligible.length > 1) {
    warnings.push(
      `${eligible.length} offene Deals fuer ${parsed.email} (${eligible.map((x) => x.fields.deal_id ?? x.id).join(", ")}) - ` +
        `Order ${parsed.orderId} nicht automatisch zuordenbar.`
    );
    return { ...base, action: "ambiguous" };
  }

  const deal = eligible[0];
  const writes = { ...parsed.fields };

  // payment_model: Der Closer setzt es meist VOR der Bestellung (der checkout_link haengt daran).
  // Leeres Feld -> ableiten. Gesetztes Feld bleibt, Abweichung wird gemeldet.
  const existingPm = deal.fields.payment_model?.name ?? deal.fields.payment_model ?? null;
  if (!existingPm) {
    if (pm.model) writes.payment_model = pm.model;
    else warnings.push(`payment_model bleibt leer: ${pm.reason}`);
  } else if (pm.model && pm.model !== existingPm) {
    warnings.push(
      `payment_model im Deal ("${existingPm}") weicht von der Bestellung ab (Easy2 sagt "${pm.model}") - ` +
        "Deal-Wert bleibt, bitte pruefen (Preis-Guard im Script bricht sonst ab)."
    );
  } else if (!pm.model) {
    warnings.push(`payment_model im Deal ("${existingPm}") nicht gegen Easy2 pruefbar: ${pm.reason}`);
  }

  // Leere Strings nicht schreiben (der Zap hat Felder ohne Wert ebenfalls leer gelassen).
  for (const [k, v] of Object.entries(writes)) if (v === "" || v == null) delete writes[k];

  return { ...base, action: "update", dealRecordId: deal.id, dealId: deal.fields.deal_id, writes };
}

/** Feld-fuer-Feld-Vergleich geplante Writes vs. aktueller Deal-Stand (fuers Shadow-Log). */
export function diffAgainstDeal(writes, deal) {
  if (!deal) return {};
  const out = {};
  for (const [k, v] of Object.entries(writes || {})) {
    const cur = deal.fields[k]?.name ?? deal.fields[k] ?? null;
    const same = typeof v === "number" ? sameMoney(cur, v) : (cur ?? "") === v;
    if (!same) out[k] = { current: cur, would_write: v };
  }
  return out;
}

export function extractOrder(body) {
  const cand = body?.order || body?.data || body;
  return cand && typeof cand === "object" ? cand : null;
}

export function mergeNote(existing, note) {
  return existing ? `${note}\n---\n${existing}` : note;
}

/**
 * deps: { findDealsByEmail(email) -> records[], updateDeal(id, fields), fetchOrder?(id) -> order, alert?(msg, details) }
 * Rueckgabe wird vom Webhook als Antwort-JSON verwendet.
 */
export async function processOrderCreated(body, { mode = "shadow", deps, log = console }) {
  if (mode === "off") return { skipped: true, reason: "EASY2_ORDERS_MODE=off" };

  let order = extractOrder(body);
  if (order && !Array.isArray(order.items) && order.id && deps.fetchOrder) {
    // Payload ohne Positionen -> volle Order per API nachladen.
    order = await deps.fetchOrder(order.id);
  }
  if (!order || !Array.isArray(order.items)) {
    log.error("[order] Payload nicht als Order erkennbar:", JSON.stringify(body));
    throw new Error("order_created: Payload nicht als Order erkennbar");
  }

  const parsed = parseOrder(order);
  const deals = parsed.email ? await deps.findDealsByEmail(parsed.email) : [];
  const plan = planOrder(parsed, deals);
  const target = deals.find((d) => d.id === plan.dealRecordId);

  const entry = {
    mode,
    orderId: parsed.orderId,
    email: parsed.email,
    action: plan.action,
    dealRecordId: plan.dealRecordId || null,
    dealId: target?.fields.deal_id ?? null,
    paymentModelDerived: plan.paymentModel.model,
    paymentModelNote: plan.paymentModel.reason,
    writes: plan.writes || null,
    diffVsCurrentDeal: plan.action === "update" ? diffAgainstDeal(plan.writes, target) : undefined,
    noteWrites: plan.noteWrites?.map((n) => ({ dealRecordId: n.dealRecordId, note: n.note })) || undefined,
    warnings: plan.warnings,
  };
  const tag = mode === "live" ? "[order-live]" : "[order-shadow]";
  const level = plan.action === "update" || plan.action === "already_applied" ? (plan.warnings.length ? "warn" : "log") : "warn";
  log[level](`${tag} ${JSON.stringify(entry)}`);

  if (mode !== "live") return { mode, ...entry };

  // --- live ---
  if (plan.action === "update") {
    await deps.updateDeal(plan.dealRecordId, plan.writes);
  } else if (plan.action === "blocked") {
    for (const n of plan.noteWrites) {
      await deps.updateDeal(n.dealRecordId, { payment_note: mergeNote(n.existingNote, n.note) });
    }
  }
  if (!["update", "already_applied"].includes(plan.action) || plan.warnings.length) {
    await deps.alert?.(`Easy2-Order ${parsed.orderId}: ${plan.action}`, entry);
  }
  return { mode, ...entry };
}
