/** Optionaler Fehler-Alert (Slack Incoming Webhook). Ohne SLACK_WEBHOOK_URL nur Log. */
export async function alertFailure(message, details = {}) {
  console.error("[ALERT]", message, details);
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:rotating_light: WebinarGeek-Airtable-Sync: ${message}\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``,
      }),
    });
  } catch (err) {
    console.error("[ALERT] Slack-Benachrichtigung fehlgeschlagen:", err?.message);
  }
}
