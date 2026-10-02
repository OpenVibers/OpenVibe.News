'use strict';
/**
 * openvibe-sdk/service (plan T1): the shared JSON body parser answers 413 for a body over the limit
 * (the hand-rolled one answered 400 request.invalid_json there), and the entry point's graceful stop
 * runs its stop and close steps and exits 0.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createLifecycle } = require('../server/index');

(async () => {
    const t = await boot();

    await check('a JSON body over 512 kB is 413 request.too_large, not 400 request.invalid_json', async () => {
        const r = await t.api('/stories', { json: { headline: 'Big', padding: 'y'.repeat(600 * 1024) } });
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json().code, 'request.too_large');
    });

    await check('the entry point stop runs its stop and close steps, then exits 0', async () => {
        const steps = [];
        const spy = (obj, method, label) => {
            const orig = obj[method].bind(obj);
            obj[method] = (...a) => { steps.push(label); return orig(...a); };
        };
        spy(t.ctx.worker, 'stop', 'worker.stop');
        spy(t.ctx.outbox, 'stop', 'outbox.stop');
        spy(t.ctx.store, 'close', 'store.close');

        const server = http.createServer(t.app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        const exits = [];
        const lifecycle = createLifecycle({ server, ctx: t.ctx, exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, ['worker.stop', 'outbox.stop', 'store.close']);
        assert.strictEqual(server.listening, false);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
