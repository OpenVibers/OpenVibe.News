'use strict';
/**
 * Static assets take their Cache-Control from openvibe-shared/cache-policy (plan T11): only the exact
 * content-hashed ?v= the page links (assetVersion) is immutable for a year; a wrong or missing ?v= is
 * the short public window with stale-while-revalidate the module hands out — a hex-looking value the
 * render never produced must never be pinned as immutable.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const cssVersion = require('../server/render/layout').assetVersion('css/news.css');

    await check('the current ?v=<assetVersion> is immutable for a year', async () => {
        const r = await t.get(`/css/news.css?v=${cssVersion}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    await check('a wrong-but-hex ?v= and no ?v= get the short public window, never immutable', async () => {
        for (const path of ['/css/news.css?v=deadbeefdeadbeef', '/css/news.css']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, `${path} → ${r.status}`);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400', path);
        }
    });

    await t.close();
    done();
})();
