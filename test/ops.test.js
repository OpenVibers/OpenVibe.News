'use strict';
/**
 * Operator and discovery surfaces: health, truthful readiness, release, metrics, robots.txt with an
 * explicit automated-consumer policy, llms.txt, the sitemap index, legal pages, 404s, problem+json
 * with request ids, CORS for the network's origins, and the topics-only seed (idempotent).
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('health, readiness (degraded honestly, never falsely ok), release manifest, metrics', async () => {
        assert.strictEqual((await t.get('/api/health')).json().status, 'ok');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = ready.json();
        assert.strictEqual(body.checks.db.status, 'ok');
        assert.strictEqual(body.checks.network_jwks.status, 'ok');
        assert.strictEqual(body.checks.events_webhook.status, 'ok');
        assert.ok(body.degraded.includes('events_relay'), 'the relay is honestly reported off in tests');
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'news');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const m = await t.get('/metrics');
        assert.ok([200, 404].includes(m.status));
    });

    await check('robots.txt: sitemap, automated-consumer policy, editor/API disallowed; llms.txt; sitemap index', async () => {
        const robots = (await t.get('/robots.txt')).text;
        assert.match(robots, /Sitemap: https:\/\/openvibe\.news\/sitemap\.xml/);
        assert.match(robots, /automated-consumer policy/);
        for (const p of ['/edit', '/clusters/', '/api/', '/internal/']) assert.ok(robots.includes(`Disallow: ${p}`), p);
        const llms = (await t.get('/llms.txt')).text;
        assert.match(llms, /^# OpenVibe\.News/);
        assert.match(llms, /not an automatic headline generator/);
        assert.match(llms, /\.json/);
        const idx = (await t.get('/sitemap.xml')).text;
        assert.match(idx, /<sitemapindex/);
        assert.match(idx, /sitemaps\/stories\.xml/);
        assert.match(idx, /sitemaps\/topics\.xml/);
        const empty = (await t.get('/sitemaps/stories.xml')).text;
        assert.doesNotMatch(empty, /<url>/, 'no stories, no URLs');
        const home = await t.get('/');
        assert.match(home.text, /<meta name="robots" content="noindex, follow">/, 'an empty front page is not offered for indexing');
    });

    await check('legal pages, 404s and API problems', async () => {
        assert.strictEqual((await t.get('/terms')).status, 200);
        const nf = await t.get('/stories/nothing-here');
        assert.strictEqual(nf.status, 404);
        assert.strictEqual(nf.headers.get('cache-control'), 'private, no-store');
        const p = await t.get('/api/v1/stories/sty_nope');
        assert.strictEqual(p.status, 404);
        assert.match(p.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(p.json().code, 'story.not_found');
        assert.ok(p.json().request_id);
        assert.strictEqual(p.headers.get('x-robots-tag'), 'noindex');
        const bad = await t.get('/api/v1/stories', { as: 'not-a-token.x.y', json: {} });
        assert.ok([401, 403].includes(bad.status));
    });

    await check('CORS: network origins may call the API; others get no CORS headers', async () => {
        const ok = await t.get('/api/v1/topics', { headers: { origin: 'https://openvibe.network' } });
        assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://openvibe.network');
        const no = await t.get('/api/v1/topics', { headers: { origin: 'https://evil.example' } });
        assert.strictEqual(no.headers.get('access-control-allow-origin'), null);
    });

    await check('the seed is topics only, idempotent, and never touches an existing topic', async () => {
        const n = t.db().prepare('SELECT COUNT(*) AS n FROM news_topics').get().n;
        t.db().prepare("UPDATE news_topics SET name = 'Space (renamed by an editor)' WHERE slug = 'space'").run();
        await t.restart();
        assert.strictEqual(t.db().prepare('SELECT COUNT(*) AS n FROM news_topics').get().n, n);
        assert.strictEqual(t.db().prepare("SELECT name FROM news_topics WHERE slug = 'space'").get().name, 'Space (renamed by an editor)');
        const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { ...process.env, NEWS_DB_PATH: t.dbPath }, encoding: 'utf8' });
        assert.match(out, /topics: 0 added, \d+ already present/);
        for (const table of ['news_stories', 'news_source_items', 'news_story_clusters']) assert.strictEqual(t.db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    });

    await t.close();
    done();
})();
