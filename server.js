/**
 * FFC Telegram Webhook Proxy
 * --------------------------
 * Sits in FRONT of ManyChat on the FFC setter Telegram bot.
 *
 *   Telegram  ──►  THIS PROXY  ──►  ManyChat webhook   (so every ManyChat flow keeps working, untouched)
 *                       └────────►  Setter app /ingest/tg-media  (pulls images / voice notes / videos the
 *                                                                 setter dashboard could never see before)
 *
 * Critical rule: the forward to ManyChat is the hot path. We only tell Telegram "200 OK" when ManyChat
 * accepted the update — otherwise we 502 so Telegram retries and no lead message is ever lost.
 * Media extraction is best-effort and never blocks or breaks the ManyChat forward.
 *
 * ROLLBACK (if anything is wrong): point Telegram's webhook straight back at ManyChat:
 *   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<MANYCHAT_WEBHOOK_URL>"
 */
const express = require('express');

const PORT = process.env.PORT || 4000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';                 // FFC setter bot token
const MANYCHAT_WEBHOOK_URL = process.env.MANYCHAT_WEBHOOK_URL || ''; // ManyChat's real webhook (we forward here)
const INGEST_URL = process.env.INGEST_URL || '';              // setter app, e.g. https://ffc-setter-dashboard.onrender.com/ingest/tg-media
const PATH_SECRET = process.env.PATH_SECRET || 'ffc-tg-9x7q';  // our own secret in the webhook path

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, hasToken: !!BOT_TOKEN, hasMC: !!MANYCHAT_WEBHOOK_URL, hasIngest: !!INGEST_URL }));

// DEBUG ring buffer of the last few updates + what we did with them
const DEBUG = [];
function dbg(o) { DEBUG.unshift({ t: new Date().toISOString(), ...o }); if (DEBUG.length > 15) DEBUG.pop(); }
app.get('/debug', (req, res) => { if (req.query.key !== 'clawd26') return res.status(403).json({}); res.json(DEBUG); });

// pull a downloadable file_id + type out of a Telegram message (largest photo size, voice, video, etc.)
function extractMedia(msg) {
  if (!msg) return null;
  if (msg.photo && msg.photo.length) return { type: 'image', file_id: msg.photo[msg.photo.length - 1].file_id };
  if (msg.voice) return { type: 'voice', file_id: msg.voice.file_id };
  if (msg.audio) return { type: 'audio', file_id: msg.audio.file_id };
  if (msg.video) return { type: 'video', file_id: msg.video.file_id };
  if (msg.video_note) return { type: 'video', file_id: msg.video_note.file_id };
  if (msg.animation) return { type: 'video', file_id: msg.animation.file_id };
  if (msg.sticker) return { type: 'image', file_id: msg.sticker.file_id };
  if (msg.document) return { type: 'document', file_id: msg.document.file_id, name: msg.document.file_name || '' };
  return null;
}

// best-effort: tell the setter app a lead sent media (never throws into the hot path)
async function sendMediaToSetter(update) {
  try {
    if (!INGEST_URL) return;
    const msg = update.message || update.edited_message || update.channel_post;
    const media = extractMedia(msg);
    dbg({ keys: msg ? Object.keys(msg) : null, media });
    if (!media) return;
    const from = (msg && msg.from) || {};
    const r = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriber_id: String(from.id || (msg.chat && msg.chat.id) || ''),
        name: [from.first_name, from.last_name].filter(Boolean).join(' '),
        username: from.username || '',
        type: media.type,
        file_id: media.file_id,
        file_name: media.name || '',
        caption: (msg && msg.caption) || '',
        t: ((msg && msg.date) || Math.floor(Date.now() / 1000)) * 1000,
      }),
    });
    dbg({ ingest_status: r.status, sid: String(from.id || '') });
  } catch (e) { dbg({ ingest_error: e.message }); console.error('[media] ingest failed:', e.message); }
}

app.post('/tg/:secret', async (req, res) => {
  if (req.params.secret !== PATH_SECRET) return res.status(403).json({ ok: false });
  const update = req.body || {};

  // 1) HOT PATH — forward verbatim to ManyChat. Lead messaging must never break.
  let mcOk = false;
  try {
    const r = await fetch(MANYCHAT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    mcOk = r.ok;
  } catch (e) {
    console.error('[forward] ManyChat forward error:', e.message);
  }

  // 2) best-effort media pull (don't block the response on it)
  sendMediaToSetter(update);

  // only 200 when ManyChat accepted it; else 502 so Telegram retries (no lost messages)
  if (mcOk) return res.json({ ok: true });
  return res.status(502).json({ ok: false });
});

app.listen(PORT, () => console.log(`FFC TG proxy on :${PORT}  (MC:${!!MANYCHAT_WEBHOOK_URL} ingest:${!!INGEST_URL})`));
