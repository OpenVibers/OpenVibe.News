'use strict';

/**
 * OpenVibe.News — process entry. `node server/index.js`
 * Listens on PORT (4820) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (the OpenVibe.Sources cursor pull).
 */
const { createApp } = require('./app');

const { app, ctx } = createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[News] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[News] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; webhook ${config.events.webhookSecrets.length ? 'on' : 'off (NEWS_EVENTS_SECRET unset)'}; Sources pull ${config.worker.enabled && config.sources.pullIntervalMs ? `every ${config.sources.pullIntervalMs} ms` : 'off'}; AI ${ctx.ai.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.worker.start();

function shutdown(signal) {
    console.log(`[News] ${signal}: closing`);
    ctx.worker.stop();
    server.close(async () => {
        try { await ctx.outbox.stop(); } catch { /* best effort */ }
        try { ctx.store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
