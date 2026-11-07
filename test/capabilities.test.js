'use strict';
/**
 * The news.* capabilities are released by openvibe-contracts, so the service guards delegate to the
 * library's grant rule rather than deciding a proposed id locally. These pin that: every guarded id
 * is defined by the installed contracts and the news service manifest; and checkCapability agrees
 * with capabilities.check for an exact grant, a prefix grant, no grant, and an id nobody defines.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES, PROPOSED } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('every guarded capability is defined by the installed contracts and the news manifest', () => {
        const manifest = services.get('news');
        assert.ok(manifest, 'openvibe-contracts defines the news service manifest');
        const released = Object.values(CAPABILITIES).filter((id) => capabilities.get(id));
        assert.deepStrictEqual([...manifest.capabilities].sort(), released.sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            if (!cap) {
                assert.ok(PROPOSED.has(id), `${id} is not released yet, so it must be a local proposal`);
                continue;
            }
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
        // An id nobody defines still answers capability.unknown — the guard only falls back for a proposal.
        assert.strictEqual(checkCapability({ cap: ['news.*'] }, 'news.not.a.capability').code, 'capability.unknown');
    });

    done();
})();
