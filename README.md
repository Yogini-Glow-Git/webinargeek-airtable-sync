# WebinarGeek/Easy2 → Airtable Sync

Ersetzt Zapier-Zaps (siehe `wiki/workflows/workflows-zaps.md` im
Finanz-Dashboard-Projekt) durch direkte Webhook-Empfänger auf einem Service:

- **`POST /webhooks/webinargeek`** — ersetzt **"WebinarGeek Registration →
  Leads"** (344 Tasks/Monat). Bildet dieselbe Logik nach: dynamische `wg_id`,
  UTM-Fallback (`direct`/`none`/`direct-organic`), Campaign- und
  Webinar-Find-or-Create, Lead-Upsert auf `lead_id = {wg_id}_{datum}_{email}`.
  **Live, alter Zap ist aus.**
- **`POST /webhooks/easy2`** (Event `form_submitted`) — zwei unabhängige
  Aktionen pro eingehendem Contact, je nach Easy2-Liste:
  - Liste `178254506`/`105659590` (Ausbildungsbroschüre/YogaReport) → ersetzt
    **"Easy2 yogareport+LM → Airtable Lead"** + **"Easy2 Warteliste+LM →
    Airtable Lead"** (zusammen ~231 Tasks/Monat, siehe `lib/leadMagnet.js`).
    Lead-Upsert auf `lead_id = easy2_{email}`.
  - Liste `238677122` ("8. Webinar Anmeldung") → ersetzt **"Easy2 to
    Webinargeek Anmeldung"** (183 Tasks/Monat, größter Einzelposten, siehe
    `lib/webinarRegistration.js`): registriert direkt per WebinarGeek-API für
    den **nächsten** Termin des einen dauerhaft aktiven Webinars (Id
    `517362`, dynamisch ermittelt — kein Hardcoding eines Datums, "datet"
    sich nach jedem Webinar automatisch auf den nächsten Termin um). Löst
    danach automatisch den bestehenden `/webhooks/webinargeek`-Endpoint aus
    (WebinarGeeks eigenes "New registration"-Webhook), der den Lead in
    Airtable anlegt — kein separater Airtable-Write hier nötig.
  - **Läuft parallel im Shadow-Modus** zu den bestehenden Zaps — Airtable-
    Upserts sind idempotent auf `lead_id`; WebinarGeek ist laut eigener
    API-Doku bei Doppel-Registrierung (gleiche Email + gleicher Termin)
    ebenfalls idempotent ("silently skip"), kein Doppel-Versand-Risiko.
  - Noch NICHT gebaut: `booking_created` → Calls (ersetzt "Easy2 Termin
    Webinartermin to Airtable", 29 Tasks) — wird aktuell nur geloggt.

**Ersetzt NICHT** die Live-/Replay-Viewer-Zaps und den Easy2→Deals-Zap — die
laufen unverändert weiter.

## Setup

```bash
npm install
cp .env.example .env
# .env ausfuellen: AIRTABLE_TOKEN, WEBINARGEEK_WEBHOOK_SECRET
npm start
```

## Deployment

Läuft als simpler Node/Express-Prozess (`Dockerfile` liegt bei). Braucht eine
öffentlich erreichbare HTTPS-URL für den Webhook-Endpoint
(`POST /webhooks/webinargeek`).

## WebinarGeek-Webhook einrichten

**Wichtig:** Lässt sich nur im Dashboard konfigurieren, nicht per API.

1. WebinarGeek → **Account → Integrations → Webhooks** → neuen Webhook anlegen.
2. **URL:** `https://<deine-deployment-domain>/webhooks/webinargeek`
3. **Secret:** ein zufälliger String, exakt derselbe Wert wie
   `WEBINARGEEK_WEBHOOK_SECRET` in `.env`.
4. **Event:** "New registration" auswählen.
5. Bestehenden Zap **NICHT sofort abschalten** — beide können parallel laufen
   (Schatten-Modus), da WebinarGeek mehrere Webhooks gleichzeitig unterstützt.
   Erst nach ein paar Tagen Beobachtung den alten Zap deaktivieren.

## Easy2-Webhook einrichten

Anders als WebinarGeek lässt sich der Easy2-Webhook per API anlegen (kein
Dashboard-Klick nötig):

```bash
curl -X POST https://yogini-glow.easy2.de/api/site/webhooks \
  -H "Authorization: Bearer $EASY2_API_KEY" -H "Content-Type: application/json" \
  -d '{"target":"https://<deployment-domain>/webhooks/easy2","secret":"<EASY2_WEBHOOK_SECRET>","events":["form_submitted","booking_created"]}'
```

Bestehender Webhook (Zapier, `easy2toolbox.de`) bleibt unangetastet — Easy2
unterstützt mehrere parallele Webhook-Ziele.

## Offene Punkte: exakte Payload-Form

- **WebinarGeek:** Doku nennt als Beispiel-Payload das Event
  `webinar_subscribed`, aber das ist nicht 100% verifiziert. `server.js`
  akzeptiert deshalb per Default mehrere plausible Namen
  (`WG_REGISTRATION_EVENTS`) und **loggt jedes unbekannte Event mit vollem
  Payload**, statt es stillschweigend zu verwerfen. Nach der ersten echten
  Anmeldung im Log nachsehen, welcher Event-Name tatsächlich ankam, und ggf.
  einschränken (kein Code-Redeploy nötig, nur Server neu starten).
- **Easy2:** Die Form des `form_submitted`-Webhook-Payloads ist NICHT an
  einem echten Event verifiziert (nur die REST-API-Form von `GET
  /api/site/contacts` ist bekannt und wird angenommen). `server.js` loggt
  deshalb **jedes** Easy2-Event mit vollem Payload. Nach dem ersten echten
  Download/Formular-Submit im Log prüfen, ob `contact.subscriberLists`,
  `contact.properties`, `contact.name` wie erwartet ankommen — sonst
  `lib/leadMagnet.js` an die echte Form anpassen.
- **Easy2 List-Id-Mapping:** `lib/leadMagnet.js` kennt aktuell nur zwei
  verifizierte Listen (Ausbildungsbroschüre `178254506`, YogaReport
  `105659590` — **Achtung:** das alte Zapier-Wiki nennt für YogaReport
  fälschlich `110963178`, das ist live tatsächlich eine andere Liste). Die
  Warteliste-LM-Liste ist noch nicht identifiziert — Leads aus unbekannten
  Listen werden bewusst NICHT geschrieben, nur geloggt (`skipped: true` im
  Response/Log), bis die richtige List-Id bestätigt ist.

## Monitoring

- `GET /health` für Uptime-Checks.
- Fehlgeschlagene Verarbeitungen werden geloggt und (falls `SLACK_WEBHOOK_URL`
  gesetzt) an Slack gemeldet. Ohne Slack-Webhook: Server-Logs beobachten,
  besonders in den ersten Tagen nach dem Umschalten.

## Bekannte Grenzen / bewusst nicht nachgebaut

- **UTM-Attribution:** WebinarGeek liefert `extra_fields` bei den geprüften
  Registrierungen durchgehend leer — d.h. UTMs kommen schon im aktuellen Zap
  nicht durch, es wird auf `direct`/`none`/`direct-organic` zurückgefallen.
  Dieses Verhalten wird hier 1:1 repliziert, nicht "repariert" (das wäre eine
  separate Änderung an der Easy2→WebinarGeek-Strecke).
- **Attribution-Verknüpfung von Calls/Deals:** bleibt unverändert Aufgabe des
  separaten Attribution-Scripts in Airtable — dieser Service legt nur
  Lead/Webinar/Campaign an, fasst `lead`-Links an Calls nicht an.
