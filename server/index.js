'use strict';

/**
 * OpenVibe.News — process entry. `node server/index.js`
 * Listens on PORT (4820) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (the OpenVibe.Sources cursor pull).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the Sources pull worker stops
 * taking new work, the HTTP drain runs (defaults 4000/5000), then the outbox settles and the store
 * closes; past the deadline the process exits 0, as the hand-rolled 5 s timer did. Exported so a test
 * can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals }) {
    return gracefulStop({
        name: 'News', server, deadlineExitCode: 0, exit, signals,
        stop: [() => ctx.worker.stop()],
        close: [() => ctx.outbox.stop(), () => ctx.store.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[News] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
        console.log(`[News] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; webhook ${config.events.webhookSecrets.length ? 'on' : 'off (NEWS_EVENTS_SECRET unset)'}; Sources pull ${config.worker.enabled && config.sources.pullIntervalMs ? `every ${config.sources.pullIntervalMs} ms` : 'off'}; AI ${ctx.ai.enabled ? 'on' : 'off'}`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.outbox.start();
    ctx.worker.start();

    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[News] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
