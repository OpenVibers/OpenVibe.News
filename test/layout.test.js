'use strict';
/**
 * The page shell (server/render/layout.js): every rendered page carries the boost marker (its content
 * is the release the page was built from) and the shared boost script tag pointed at <main id="main">,
 * so the site moves between its pages without a reload (openvibe-shared/boost, plan T11). The shared
 * navbar's sign-in is a {path} template so it returns to whatever page is showing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('every rendered page carries the boost marker and the boost script tag with data-main="#main"', async () => {
        for (const path of ['/', '/topics', '/updates']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, `${path} → ${r.status}`);
            assert.ok(/<meta name="ov-boost" content="news@[^"]+">/.test(r.text), `${path}: boost marker with the release`);
            assert.ok(/<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/.test(r.text), `${path}: boost script tag`);
            assert.ok(r.text.includes('<main id="main"'), `${path}: the swappable <main id="main">`);
        }
    });

    await check('the shared navbar signs in through the {path} template (sign-in returns to the current page)', async () => {
        const home = await t.get('/');
        assert.ok(home.text.includes('"loginUrl":"/auth/login?next={path}"'), 'loginUrl is a {path} template');
    });

    await t.close();
    done();
})();
