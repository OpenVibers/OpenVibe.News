'use strict';

/**
 * Who may do what. News is an editorial product: readers read published stories; editors do
 * everything else.
 *
 *   editor   a signed-in Network user whose subject is in NEWS_EDITORS, or a Network admin (staff);
 *            or a service token acting for such a person (X-OV-Subject)
 *   ai       a service token with X-OV-Origin: ai may deliver a DRAFT revision (news.story.revise)
 *            and nothing else; its revisions are AI-generated and need a person's review
 *
 * Service tokens are additionally judged by their capability at the route (auth/viewer.js guard).
 */
const { ApiError } = require('../http/errors');

function isStaff(viewer) { return Boolean(viewer && viewer.kind === 'user' && viewer.staff); }

function isEditor(config, viewer) {
    if (!viewer || !viewer.subject) return false;
    if (viewer.kind === 'user') return viewer.staff || config.editors.includes(viewer.subject);
    if (viewer.kind === 'service' && viewer.origin !== 'ai') return config.editors.includes(viewer.subject);
    return false;
}

function isAiDelivery(viewer) { return Boolean(viewer && viewer.kind === 'service' && viewer.origin === 'ai'); }

/** Refuse unless the viewer is an editor (403) — anonymous callers get 401. */
function requireEditor(config, viewer) {
    if (!viewer || viewer.kind === 'anonymous') throw new ApiError(401, 'auth.required', 'Sign in with an editor account');
    if (!isEditor(config, viewer)) throw new ApiError(403, 'news.editor_required', 'Only News editors can do this (NEWS_EDITORS, or a Network admin)');
    return viewer.subject;
}

module.exports = { isStaff, isEditor, isAiDelivery, requireEditor };
