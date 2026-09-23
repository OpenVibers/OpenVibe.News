'use strict';

/**
 * Capability checks for service tokens (audience openvibe.news), including the ids News introduces
 * before the contracts library knows them.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. News' ids are proposed in docs/capabilities-proposal/ for the next contracts
 * release; until then a grant is decided locally with the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it). An id the library does know always goes through the
 * library, so the day the release lands nothing changes here.
 *
 * Browsers (Network user JWTs) are never judged by capabilities: they are judged as editors
 * (domain/access.js). A service token is judged by its capability AND, except for AI draft
 * delivery, by whether the person it acts for (X-OV-Subject) is an editor.
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    STORY_CREATE: 'news.story.create',
    STORY_READ: 'news.story.read',
    STORY_REVISE: 'news.story.revise',
    STORY_PUBLISH: 'news.story.publish',
    STORY_RETRACT: 'news.story.retract',
    CLUSTER_READ: 'news.cluster.read',
    CLUSTER_MANAGE: 'news.cluster.manage',
    SOURCE_ATTACH: 'news.source.attach',
    TIMELINE_UPDATE: 'news.timeline.update',
    PERSPECTIVE_UPDATE: 'news.perspective.update',
    TOPIC_MANAGE: 'news.topic.manage',
});
const PROPOSED = new Set(Object.values(CAPABILITIES));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, checkCapability };
