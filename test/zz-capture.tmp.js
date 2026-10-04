'use strict';
const { boot } = require('./helpers/boot');
const PARA = 'Officials confirmed on Tuesday that the regional water authority will open two new treatment plants next spring, adding capacity for roughly 400,000 residents across the valley and ending the seasonal restrictions of recent summers. The authority said construction is on schedule and within the approved budget.';
async function storyOn(t, headline, items) {
    let r = await t.api('/stories', { json: { headline } });
    const story = r.json().story;
    for (const it of items) await t.api(`/stories/${story.id}/sources`, { json: { item: it.id } });
    await t.api(`/stories/${story.id}/revisions`, { json: { body: `${PARA} [${items.map((_, i) => i + 1).join(', ')}]`, expected_revision: 0 } });
    await t.api(`/stories/${story.id}/publish`, { json: {} });
    return story;
}
const tags = (html) => {
    const head = html.slice(0, html.indexOf('</head>'));
    const out = head.match(/<(meta|link|script|title)\b[^>]*>/g) || [];
    const body = html.slice(html.indexOf('</head>'));
    const bodyTags = body.match(/<(script|noscript|main|div id="navbar-mount"|footer|nav)\b[^>]*>/g) || [];
    return out.join('\n') + '\n--- body ---\n' + bodyTags.join('\n');
};
(async () => {
    const t = await boot();
    const S = t.sources;
    S.addSource('alpha-news', { name: 'Alpha News' });
    S.addSource('beta-daily', { name: 'Beta Daily' });
    const a = S.addItem({ source_key: 'alpha-news', title: 'Water agency says two plants will open', url: 'https://alpha.example/a/water' });
    const b = S.addItem({ source_key: 'beta-daily', title: 'Budget vote clears way for valley water projects', url: 'https://beta.example/b/budget-vote' });
    await t.pull();
    const good = await storyOn(t, 'Two treatment plants to open next spring', [a, b]);
    const thin = await storyOn(t, 'Single-source water story', [a]);
    const fs = require('fs');
    const dir = process.env.CAP_DIR;
    for (const [name, p] of [['indexable', `/stories/${good.slug}`], ['noindex', `/stories/${thin.slug}`], ['home', '/']]) {
        const r = await t.get(p);
        fs.writeFileSync(`${dir}/${name}.html`, r.text);
        fs.writeFileSync(`${dir}/${name}.tags`, tags(r.text));
    }
    await t.close();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
