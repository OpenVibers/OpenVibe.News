'use strict';
/**
 * The page shell (server/render/layout.js): every rendered page carries the boost marker (its content
 * is the release the page was built from) and the shared boost script tag pointed at <main id="main">,
 * so the site moves between its pages without a reload (openvibe-shared/boost, plan T11). The shared
 * navbar's sign-in is a {path} template so it returns to whatever page is showing. The document is
 * openvibe-publishing/layout's (openvibe-shared/shell page()): one title, the canonical and robots
 * from the gate's decision, the JSON-LD, feeds, stylesheet, the Frame and the footer's init.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');

const PARA = 'Officials confirmed on Tuesday that the regional water authority will open two new treatment plants next spring, adding capacity for roughly 400,000 residents across the valley and ending the seasonal restrictions of recent summers. The authority said construction is on schedule and within the approved budget.';

/** A published story resting on these Sources items (cited in its one paragraph). */
async function storyOn(t, headline, items) {
    let r = await t.api('/stories', { json: { headline } });
    assert.strictEqual(r.status, 201, r.text);
    const story = r.json().story;
    for (const it of items) {
        r = await t.api(`/stories/${story.id}/sources`, { json: { item: it.id } });
        assert.ok(r.status === 200 || r.status === 201, r.text);
    }
    r = await t.api(`/stories/${story.id}/revisions`, { json: { body: `${PARA} [${items.map((_, i) => i + 1).join(', ')}]`, expected_revision: 0 } });
    assert.strictEqual(r.status, 201, r.text);
    r = await t.api(`/stories/${story.id}/publish`, { json: {} });
    assert.strictEqual(r.status, 200, r.text);
    return story;
}

const count = (html, re) => (html.match(re) || []).length;

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

    await check('a page needs the gate decision: there is no default that makes it indexable', async () => {
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.news' } }), TypeError);
    });

    await check('the document head and frame come from openvibe-publishing/layout, robots from the decision', async () => {
        t.sources.addSource('alpha-news', { name: 'Alpha News' });
        t.sources.addSource('beta-daily', { name: 'Beta Daily' });
        const a = t.sources.addItem({ source_key: 'alpha-news', title: 'Water agency says two plants will open', url: 'https://alpha.example/a/water' });
        const b = t.sources.addItem({ source_key: 'beta-daily', title: 'Budget vote clears way for valley water projects', url: 'https://beta.example/b/budget-vote' });
        await t.pull();
        const good = await storyOn(t, 'Two treatment plants to open next spring', [a, b]);
        const thin = await storyOn(t, 'Single-source water story', [a]);
        for (const [story, headline, robots] of [[good, 'Two treatment plants to open next spring', 'index, follow'], [thin, 'Single-source water story', 'noindex, follow']]) {
            const r = await t.get(`/stories/${story.slug}`);
            assert.strictEqual(r.status, 200, r.text);
            const html = r.text;
            const head = html.slice(0, html.indexOf('</head>'));
            const body = html.slice(html.indexOf('</head>'));
            assert.strictEqual(count(html, /<title>/g), 1, 'exactly one <title>');
            assert.ok(head.includes(`<title>${headline} · OpenVibe.News</title>`), 'the composed title');
            assert.ok(head.includes(`<link rel="canonical" href="https://openvibe.news/stories/${story.slug}">`), 'the canonical');
            assert.strictEqual(count(head, /<meta name="robots"/g), 1, 'one robots meta');
            assert.ok(head.includes(`<meta name="robots" content="${robots}">`), `${story.slug}: robots ${robots} from the decision`);
            assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
            assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom">'), 'Atom feed link');
            assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/feed.json" title="JSON Feed">'), 'JSON feed link');
            assert.ok(/<link rel="stylesheet" href="\/css\/news\.css\?v=[0-9a-f]+">/.test(head), 'the news stylesheet');
            assert.ok(head.includes('<meta property="article:published_time"'), 'article published time');
            assert.ok(body.includes('<div id="navbar-mount"></div>'), 'the navbar mount');
            assert.ok(body.includes('<nav aria-label="Site"'), 'the noscript navigation');
            assert.ok(body.includes('id="ov-footer"'), 'the server-rendered footer');
            assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
        }
        const home = (await t.get('/')).text;
        const head = home.slice(0, home.indexOf('</head>'));
        assert.strictEqual(count(head, /<title>/g), 1);
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.news/">'));
        assert.strictEqual(count(head, /<script type="application\/ld\+json">/g), 2, 'the home WebSite JSON-LD and the AI-summary WebPage JSON-LD');
        assert.ok(head.includes('"@type":"WebSite"'), 'the site JSON-LD');
        assert.ok(head.includes('"@type":"WebPage"'), 'the AI summary WebPage JSON-LD');
        assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom">'));
        assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/feed.json" title="JSON Feed">'));
        assert.ok(home.includes('Recently shipped on OpenVibe.News'), 'the shipped line stays on the home page');
    });

    await t.close();
    done();
})();
