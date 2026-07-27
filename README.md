# WebinarGeek → Airtable Sync

Ersetzt den Zapier-Zap **"WebinarGeek Registration → Leads"** (siehe
`wiki/workflows/workflows-zaps.md` im Finanz-Dashboard-Projekt) durch einen
direkten Webhook-Empfänger. Bildet exakt dieselbe Logik nach: dynamische
`wg_id`, UTM-Fallback (`direct`/`none`/`direct-organic`), Campaign- und
Webinar-Find-or-Create, Lead-Upsert auf `lead_id = {wg_id}_{datum}_{email}`.

**Ersetzt NICHT** die Live-/Replay-Viewer-Zaps — die laufen unverändert weiter.

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

## Offener Punkt: exakter Event-Name

Die WebinarGeek-Doku nennt als Beispiel-Payload das Event `webinar_subscribed`,
aber das ist nicht 100% verifiziert. `server.js` akzeptiert deshalb per Default
mehrere plausible Namen (`WG_REGISTRATION_EVENTS`) und **loggt jedes
unbekannte Event mit vollem Payload**, statt es stillschweigend zu verwerfen.
Nach der ersten echten Anmeldung im Log nachsehen, welcher Event-Name
tatsächlich ankam, und `WG_REGISTRATION_EVENTS` in der `.env` ggf. darauf
einschränken (kein Code-Redeploy nötig, nur Server neu starten).

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
