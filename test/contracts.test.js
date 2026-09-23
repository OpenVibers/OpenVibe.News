'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid against the
 * released schemas, match what the code enforces, and do not collide with released ids; every
 * event type the code emits is declared.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');
const { PROPOSED } = require('../server/auth/capabilities');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'capabilities-proposal');

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'service-manifest-proposal.json'), 'utf8'));

    await check('every capability proposal is a valid capabilities.capability@1 with 3+ segments, owned by news', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'news');
            assert.ok(c.id.split('.').length >= 3);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            const released = contracts.capabilities.get(c.id);
            assert.ok(!released || released.owner === 'news', `${c.id} collides with a released capability`);
        }
    });

    await check('the charter capabilities are all present as 3-segment ids', async () => {
        for (const id of ['news.story.create', 'news.story.revise', 'news.story.publish', 'news.cluster.read', 'news.source.attach', 'news.timeline.update']) assert.ok(PROPOSED.has(id), id);
    });

    await check('the proposals are exactly the capabilities the code enforces, and every route guard names one', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
        const api = fs.readFileSync(path.join(ROOT, 'server', 'http', 'api.js'), 'utf8');
        for (const m of api.matchAll(/(?:guard\(|write\('[a-z]+', '[^']+', )'(news\.[a-z_.]+)'/g)) assert.ok(PROPOSED.has(m[1]), m[1]);
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'news');
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), `${c.id} names ${e}, missing from eventsProduced`);
        for (const e of ['news.source.ingested', 'news.source.failed', 'news.cluster.updated', 'news.story.published', 'news.story.updated', 'news.story.retracted']) assert.ok(manifest.eventsProduced.includes(e), e);
        const released = contracts.services && contracts.services.get ? contracts.services.get('sources') : null;
        for (const e of manifest.eventsConsumed) assert.ok(!released || released.eventsProduced.includes(e), `${e} is not produced by sources`);
    });

    await check('every event type the code emits is declared', async () => {
        const src = ['server/domain/stories.js', 'server/domain/publication.js', 'server/domain/ingest.js', 'server/domain/clusters.js']
            .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
        const found = [...src.matchAll(/event_type: '([a-z_.]+)'/g)].map((m) => m[1]);
        assert.ok(found.length >= 6);
        for (const e of found) assert.ok(manifest.eventsProduced.includes(e), e);
    });

    done();
})();
