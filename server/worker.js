'use strict';
/**
 * Background work in the News process (one timer):
 *
 *   Sources cursor pull   every NEWS_PULL_INTERVAL_MS (default 5 min): read news items from
 *                         OpenVibe.Sources in change order from the stored cursor and apply them
 *                         (idempotent), the backstop for webhook deliveries that never arrived.
 *                         A failed pull is recorded and relayed once per outage; it creates nothing.
 */
function createWorker({ config, ingest, outbox, briefs = null, log = console }) {
    let timer = null;
    let briefTimer = null;

    /** AI briefs for the busiest recent clusters (server/domain/briefs.js); a failure waits for the next tick. */
    async function briefTick() {
        if (!briefs) return 0;
        try { return await briefs.sweep(); } catch (err) { log.error('[News] brief tick failed:', err.message); return 0; }
    }

    async function pullTick() {
        if (!ingest) return null;
        try {
            const r = await ingest.pull();
            await outbox.kick();
            return r;
        } catch (err) {
            log.error('[News] pull tick failed:', err.message);
            return null;
        }
    }

    return {
        pullTick,
        briefTick,
        start() {
            if (!config.worker.enabled) return;
            if (config.briefs && config.briefs.enabled && briefs) {
                briefTimer = setInterval(briefTick, config.briefs.intervalMs);
                briefTimer.unref();
                setTimeout(briefTick, 30_000).unref();
            }
            if (!config.sources.pullIntervalMs) return;
            timer = setInterval(pullTick, config.sources.pullIntervalMs);
            timer.unref();
            setTimeout(pullTick, 2000).unref();
        },
        stop() { clearInterval(timer); clearInterval(briefTimer); },
    };
}

module.exports = { createWorker };
