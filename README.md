# ffc-tg-proxy

Telegram webhook proxy that sits in FRONT of ManyChat on the FFC setter bot.
Telegram → this proxy → (1) forwards verbatim to ManyChat's webhook (flows untouched)
and (2) pulls images/voice-notes/videos to the setter dashboard `/ingest/tg-media`.

Env: `BOT_TOKEN`, `MANYCHAT_WEBHOOK_URL`, `INGEST_URL`, `PATH_SECRET`.

Webhook endpoint: `POST /tg/<PATH_SECRET>`.

Rollback (restore ManyChat as the direct webhook):
`curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<MANYCHAT_WEBHOOK_URL>"`
