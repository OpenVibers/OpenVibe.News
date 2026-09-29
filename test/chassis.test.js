'use strict';
/**
 * T9 J2: News runs on the openvibe-publishing 1.1.0 chassis. This proves the conversion:
 *   - the local copies the brief's §7 lists are gone (nothing under server/ requires them);
 *   - a dry-run ingest from the captured Sources fixture produces the same domain rows as the
 *     pre-conversion code (test/fixtures/ingest-golden.json, captured before the change);
 *   - the Search document validates against search.index-document@1, with its provenance and
 *     visibility;
 *   - the outbox row and the state change share the caller's transaction (a rollback drops both).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { feedFixture, reviseFixture, project } = require('./helpers/golden');

const ROOT = path.join(__dirname, '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest-golden.json'), 'utf8'));

// The brief's §7 deletion list for News: the chassis (openvibe-publishing/ingest and /publication)
// owns their code now. The harness denies rm, so the files may remain on disk; they must not be
// required by any live server file.
const DELETED = ['server/domain/ingest.js', 'server/domain/text.js', 'server/http/webhook.js', 'server/clients/sources.js']
    .map((f) => path.join(ROOT, f));

const PARA = 'Officials confirmed on Tuesday that the regional water authority will open two new treatment plants next spring, adding capacity for roughly 400,000 residents across the valley and ending the seasonal restrictions of recent summers. The authority said construction is on schedule and within the approved budget.';

function jsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}
function relativeRequires(file) {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((s) => s.startsWith('.'));
}

/** An editor's story resting on exactly these Sources items (cited in the one paragraph), published. */
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

(async () => {
    await check('the local chassis copies are gone: no live server file requires them', () => {
        const gone = new Set(DELETED);
        for (const file of jsFiles(path.join(ROOT, 'server'))) {
            if (gone.has(file)) continue;   // the (undeletable) files themselves
            for (const spec of relativeRequires(file)) {
                let resolved;
                try { resolved = require.resolve(path.resolve(path.dirname(file), spec)); } catch { continue; }
                assert.ok(!gone.has(resolved), `${path.relative(ROOT, file)} still requires ${spec}`);
            }
        }
        // ...and the chassis entry points are the ones the app uses.
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8'), /openvibe-publishing\/ingest/);
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8'), /\.\/domain\/source-items/);
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'domain', 'publication.js'), 'utf8'), /openvibe-publishing\/publication/);
    });

    const t = await boot();
    const reports = feedFixture(t);
    await t.pull();
    reviseFixture(t, reports);
    await t.pull();

    await check('a dry-run ingest from the captured Sources fixture produces the same domain rows as before', async () => {
        assert.deepStrictEqual(await project(t), GOLDEN);
    });

    await check('the Search document validates against search.index-document@1, with its provenance and visibility', async () => {
        const story = await storyOn(t, 'Two new water treatment plants confirmed', [reports.a, reports.c]);
        const doc = (await t.events('news.index_document.upserted')).filter((e) => e.payload.id === story.id).pop().payload;
        const v = contracts.validate('search.index-document@1', doc);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(doc.visibility, 'public');
        assert.strictEqual(doc.indexability.decision, 'index');
        assert.deepStrictEqual(doc.provenance.filter((p) => p.service === 'sources').map((p) => p.id).sort(), [reports.a.id, reports.c.id].sort());
    });

    await check('the outbox row and the state change share the caller\'s transaction (a rollback drops both)', async () => {
        const story = (await t.db().prepare('SELECT * FROM news_stories WHERE state = \'published\' LIMIT 1').get());
        const row = async () => await t.db().prepare('SELECT state, noindex FROM news_stories WHERE id = ?').get(story.id);
        const outboxCount = async () => (await t.db().prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).n;
        const before = await outboxCount();
        await assert.rejects(t.ctx.store.db.tx(async () => {
            await t.ctx.store.db.prepare('UPDATE news_stories SET noindex = 1 WHERE id = ?').run(story.id);
            await t.ctx.publication.syncIndex(await t.db().prepare('SELECT * FROM news_stories WHERE id = ?').get(story.id));
            throw new Error('rollback: the outbox row and the state change must not survive together');
        }));
        assert.strictEqual(await outboxCount(), before, 'no outbox row survives the rollback');
        assert.strictEqual((await row()).noindex, 0, 'the state change rolled back with it');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
