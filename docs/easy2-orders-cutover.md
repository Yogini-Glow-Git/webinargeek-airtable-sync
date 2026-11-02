# Easy2 `order_created` -> Deals: Shadow, Vergleich, Cutover

Ersetzt den Zap "Easy2 New Order -> Deals". Code: `lib/orders.js` (Logik), `lib/orderDeps.js` (Airtable/Easy2-I/O),
Verdrahtung in `server.js` (`POST /webhooks/easy2`, Header `X-Webhook-Topic: order_created`). Tests: `npm test`
(24 Tests, Fixtures = echte Easy2-Orders 125/159/160 in `test/fixtures/`).

**Stand: gebaut, NICHT deployed, Zap laeuft unveraendert.**

## Modus
`EASY2_ORDERS_MODE` = `off` | `shadow` (Default) | `live`. Jeder andere Wert wird wie `shadow` behandelt.
Shadow liest Airtable (GET) und loggt pro Order **eine Zeile** `[order-shadow] {...}` (action, writes,
diffVsCurrentDeal, paymentModelDerived, warnings). Es gibt im Shadow-Pfad keinen Schreibaufruf.
`node scripts/replay-orders.js 125 159 160` spielt echte Orders read-only gegen den aktuellen Airtable-Stand.

## Regeln (was anders ist als im Zap)
1. **Deal-Wahl:** per E-Mail (`lead_email_text`, exakter Treffer). Beschrieben wird nur ein Deal ohne `order_date`,
   ohne Payments und nicht storniert/verworfen. Genau ein solcher Deal -> `update`.
2. **Schon abgerechneter Deal (Zweitbestellung)** -> `blocked`: nichts ueberschreiben, `[order-shadow|live]`-Warnzeile,
   live zusaetzlich `payment_note` (vorangestellt, alte Notiz bleibt) + Slack-Alert.
3. **Redelivery/Zap war schneller:** hat der Deal schon `order_date` UND `total_amount` dieser Order -> `already_applied`, keine Warnung.
4. Kein Deal / mehrere offene Deals / Order-Status != completed -> kein Write, Warnung.
5. **payment_model:** aus Item "Zahlungskonditionen: Einmalzahlung|Split Pay|Premium Flex Plan|Extended Flex Plan" +
   Code `BLACK26NOV` (fixed_discount, 700). Nur gesetzt, wenn die Totals exakt zu `EXPECTED_TOTAL` passen.
   Leer + Grund im Log bei: kein Konditionen-Item, `individual`, fremder Rabattcode, Total passt nicht.
   **Ist `payment_model` im Deal schon gesetzt, wird es NIE ueberschrieben** (Abweichung zu Easy2 -> Warnung).
6. Felder wie beim Zap: `deal_stage=bestätigt`, `total_amount`, `product` (ungetrimmt, "," ohne Leerzeichen), `order_date`
   (Europe/Berlin), `payment_method` (bank/klarna), `billing_*`, `company_name`, `full_name`. Leere Werte werden nicht geschrieben.
   `lead`/`closer`/`training_start_date` bleiben unberuehrt.

### Entscheidungsvorschlag: Zweitbestellung -> warnen, NICHT automatisch neuen Deal anlegen
- `Deals.lead` ist ein Lookup, der Lead haengt ueber Calls am Deal. Ein automatisch angelegter Deal haette weder Lead noch
  Closer -> er faellt aus Attribution, Provision (`deal_valid_flag`/Payout) und dem Dashboard ("Ohne Zuordnung").
- Ob eine Zweitbestellung ein neuer Verkauf, eine Restzahlung (Milena: 500 EUR Anzahlung + 2.190 EUR Klarna) oder eine
  Umbuchung ist, steht nicht in der Order. Das entscheidet ein Mensch; die Warnung nennt Deal, Betrag, Code, Datum.
- Folge: kein stiller Datenverlust mehr. Aufwand pro Fall: ein Blick auf `payment_note`/Slack.

## Gegenueberstellung (Stand 2026-11-02)
Zap-Spalte = was der Zap tatsaechlich geschrieben hat (aus Deal-Notiz, Memory und Zap-Verhalten; Zapier-History selbst
war nicht einsehbar). Handler-Spalte = Ergebnis der Tests mit dem **Vorher-Stand** des Deals; "Replay live" = Lauf
`replay-orders.js` gegen den heutigen Airtable-Stand.

| Order | Kunde / Code | Zap hat geschrieben | Handler (Vorher-Stand, Test) | Replay live heute |
|---|---|---|---|---|
| 125 (27.05., 2690, bank) | Milena Sorge / - | Deal 28 korrekt (2690, 2026-05-27, bank) | `update` Deal 28: gleiche Werte; `payment_model` bleibt leer (Altorder ohne Konditionen-Item), Closer-Wert bleibt | `already_applied` |
| 159 (29.10., 2190, klarna) | Milena Sorge / MILENA500 | **Deal 28 ueberschrieben**: total 2690->2190, order_date 05-27->10-29, payment_method bank->klarna | `blocked`: Deal 28 hat order_date + Payments, nichts geschrieben, Warnung + `payment_note` | `blocked` (Warnung wie oben) |
| 160 (31.10., 1990, bank) | Miranda Furze / BLACK26NOV | **Nichts** (Deal 65 blieb leer, von Hand befuellt) | `update` Deal 65: alle Felder + `payment_model=bn_einmalzahlung_1990`, falls leer | `already_applied` (von Hand befuellt, Werte identisch) |

Zusatzbefund: Alle 29 Deals in Airtable haben `payment_model` schon VOR der Bestellung (der `checkout_link` haengt daran).
Die Ableitung ist daher vor allem ein **Gegencheck** (falsches Modell im Deal vs. tatsaechlich bestellte Konditionen),
nur bei leerem Feld ein Eintrag.
Die Handler-Felder fuer Order 160 sind 1:1 identisch mit der von Hand befuellten Deal 65 (Test `parseOrder 160`).

## Was vor dem Shadow-Start zu tun ist (Pierre)
1. **Easy2-Webhook erweitern:** unser Webhook (`rh_517011e5fdb34886`) abonniert aktuell nur `form_submitted` und
   `booking_created`. `order_created` muss ergaenzt werden (der Zap-Webhook `easy2toolbox.de` bleibt unangetastet).
   Ohne das kommt nie eine Order an. Habe ich NICHT angefasst.
2. Deploy auf Coolify (App `f5yixge4jzql0yx6itmktlf2`). Default ist `shadow`, keine Env-Aenderung noetig.
   Der Payload von `order_created` ist noch nicht an einer echten Zustellung gesehen: der Handler akzeptiert
   `{order:{...}}`, `{data:{...}}` oder die Order direkt, laedt bei fehlenden `items` per API nach und loggt den
   Payload (`[easy2-webhook] event=... payload`). Bei "nicht als Order erkennbar" -> 500 + Log.
3. Shadow-Zeilen in den Coolify-Logs suchen: `[order-shadow]`.
   Hinweis: Easy2 stellt an beide Webhooks gleichzeitig zu. Ist der Zap schneller, sieht der Handler schon dessen Werte und
   meldet `already_applied`; die Regel-Beweise liefern dann die Tests und der Replay. Zaps Ueberschreib-Fehler sieht man
   im Shadow nur indirekt (Deal mit order_date, den der Zap angefasst hat).

## Cutover-Plan
**Shadow-Abnahme (vor dem Umschalten):** mind. 3 echte Orders, davon 1 Black-November und idealerweise 1 Raten-Modell.
Pro Order muss `[order-shadow]` `action` in {`already_applied`, `update`} zeigen, `diffVsCurrentDeal` darf nur
Unterschiede in Feldern zeigen, die der Zap bewusst anders setzt (keine), und `paymentModelDerived` muss zum Deal passen.
Jede `warnings`-Zeile ist zu klaeren, bevor es weitergeht.

**Voraussetzung live:** `payment-script-v3.3.js` muss in beiden Automationen live sein (derzeit noch v3.2: bn_-Modelle ->
"Unbekanntes payment_model", keine Raten).

**Umschalten (ein Fenster, mit Pierres Freigabe):**
1. Zap "Easy2 New Order -> Deals" in Zapier **ausschalten** (nicht loeschen).
2. Coolify-Env `EASY2_ORDERS_MODE=live`, **echter Deploy** (nur Restart uebernimmt keine Env-Aenderung).
3. Erste echte Order beobachten: Deal befuellt, `order_date` gesetzt, Payments entstanden (Automation 1), keine `[order-live]`-Warnung.
   Zap und Live nicht ueberlappen lassen: der Zap wuerde Zweitbestellungen weiter ueberschreiben.

**Rollback:** Zap in Zapier wieder einschalten (keine Daten gehen verloren, er findet Deals per E-Mail) und
`EASY2_ORDERS_MODE=shadow` (oder `off`) + Deploy. Waehrend der Luecke eingegangene Orders: per
`node scripts/replay-orders.js <id>` pruefen und Deals von Hand befuellen. Live-Schreibvorgaenge des Handlers sind
Standard-PATCHes auf die oben gelisteten Felder; es gibt keine Loeschungen.

## Grenzen / offen
- Kein Easy2-Order-Marker im Deal: Idempotenz laeuft ueber `order_date` + `total_amount` (Zweitbestellung mit exakt
  gleichem Datum und Betrag wuerde als `already_applied` erscheinen). Falls gewuenscht: Feld `easy2_order_id` in Deals anlegen.
- `payment_note` einer geblockten Order kann vom Payment-Script beim naechsten erfolgreichen Lauf geleert werden;
  die dauerhafte Spur ist das Log/der Slack-Alert (`SLACK_WEBHOOK_URL` setzen, sonst nur Log).
- Altorders ohne "Zahlungskonditionen"-Item (vor Mitte 2026) und `individual` bekommen bewusst kein `payment_model`.
