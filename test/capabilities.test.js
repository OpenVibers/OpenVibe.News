'use strict';
/**
 * The news.* capabilities are released by openvibe-contracts, so the service guards delegate to the
 * library's grant rule rather than deciding a proposed id locally (the fallback that existed while
 * the ids were only proposals). These pin that: every guarded id is defined by the installed
 * contracts and by the news service manifest, and checkCapability agrees with capabilities.check for
 * an exact grant, a prefix grant, no grant, and an id the contracts do not define.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('every guarded capability is defined by the installed contracts and the news manifest', () => {
        const manifest = services.get('news');
        assert.ok(manifest, 'openvibe-contracts defines the news service manifest');
        assert.deepStrictEqual([...manifest.capabilities].sort(), Object.values(CAPABILITIES).sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            assert.ok(cap, `${id} is defined by openvibe-contracts`);
            assert.strictEqual(cap.owner, 'news', `${id} is owned by news`);
        }
    });

    await check('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', () => {
        // An exact grant and a `news.*` prefix grant the library's matching rule accepts.
        assert.deepStrictEqual(checkCapability({ cap: ['news.story.create'], sub: 'svc:sources' }, 'news.story.create'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['news.*'] }, 'news.story.create'), { allowed: true, code: null, reason: null });
        // A grant of a sibling capability, or no cap at all, is denied with the library's code.
        assert.strictEqual(checkCapability({ cap: ['news.story.read'] }, 'news.story.create').code, 'capability.denied');
        assert.strictEqual(checkCapability(null, 'news.story.create').code, 'capability.denied');
        // An id the contracts do not define still answers capability.unknown — the guard delegates,
        // it never decides an unknown id on its own.
        assert.strictEqual(checkCapability({ cap: ['news.*'] }, 'news.not.a.capability').code, 'capability.unknown');
    });

    done();
})();
