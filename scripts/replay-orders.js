// Shadow-Replay: node scripts/replay-orders.js 159 160 125
// Holt die Orders per Easy2-API, liest die Deals aus Airtable (nur GET) und zeigt, was der
// order_created-Handler schreiben WUERDE. updateDeal/alert sind hart gesperrt - kein Write moeglich.
// Achtung: gegen den AKTUELLEN Deal-Stand. Wurde ein Deal schon (vom Zap oder von Hand) befuellt,
// erscheint "already_applied"/"blocked" statt "update".
// Env: AIRTABLE_TOKEN, AIRTABLE_BASE_ID (Default appVOaD792Y5oQsu5), EASY2_API_KEY
process.env.AIRTABLE_BASE_ID ||= "appVOaD792Y5oQsu5";
const { processOrderCreated } = await import("../lib/orders.js");
const { findDealsByEmail, fetchOrder } = await import("../lib/orderDeps.js");

const ids = process.argv.slice(2);
if (!ids.length) { console.error("Usage: node scripts/replay-orders.js <orderId> ..."); process.exit(1); }
const deps = {
  findDealsByEmail, fetchOrder,
  updateDeal: async () => { throw new Error("Replay ist read-only"); },
  alert: async () => {},
};
for (const id of ids) {
  const order = await fetchOrder(id);
  await processOrderCreated({ order }, { mode: "shadow", deps });
}
