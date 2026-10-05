'use strict';

/**
 * Capability checks for service tokens (audience openvibe.news). The news.* ids this service
 * introduces are defined by the installed openvibe-contracts, so a grant is decided by the library's
 * own matching rule (the exact id, or a `prefix.*` grant covering it). CAPABILITIES keeps the ids in
 * one place for the guards, the proposal documents and the tests.
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

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, checkCapability };
