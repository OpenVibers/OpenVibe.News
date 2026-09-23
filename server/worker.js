'use strict';
/**
 * Background work in the News process (one timer):
 *
 *   Sources cursor pull   every NEWS_PULL_INTERVAL_MS (default 5 min): read news items from
 *                         OpenVibe.Sources in change order from the stored cursor and apply them
 *                         (idempotent), the backstop for webhook deliveries that never arrived.
 *                         A failed pull is recorded and relayed once per outage; it creates nothing.
 */
function createWorker({ config, ingest, outbox, log = console }) {
    let timer = null;

    async function pullTick() {
        if (!ingest) return null;
        try {
            const r = await ingest.pull();
            outbox.kick();
            return r;
        } catch (err) {
            log.error('[News] pull tick failed:', err.message);
            return null;
        }
    }

    return {
        pullTick,
        start() {
            if (!config.worker.enabled || !config.sources.pullIntervalMs) return;
            timer = setInterval(pullTick, config.sources.pullIntervalMs);
            timer.unref();
            setTimeout(pullTick, 2000).unref();
        },
        stop() { clearInterval(timer); },
    };
}

module.exports = { createWorker };
