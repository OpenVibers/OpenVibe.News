'use strict';

/**
 * Form tokens for the no-JavaScript editor forms (CSRF). The session cookie is
 * SameSite=Lax already; the token is the second lock: an HMAC of the signed-in subject under
 * NEWS_FORM_SECRET (a random per-process key when unset, so forms opened before a restart must be
 * reloaded). Never derived from anything a cross-site page can read.
 */
const crypto = require('crypto');

const fallback = crypto.randomBytes(32).toString('hex');

function csrfToken(config, viewer) {
    if (!viewer || !viewer.subject) return '';
    return crypto.createHmac('sha256', config.formSecret || fallback).update(`news-form:${viewer.subject}`).digest('base64url').slice(0, 32);
}

function checkCsrf(config, viewer, token) {
    const expected = csrfToken(config, viewer);
    if (!expected || typeof token !== 'string') return false;
    const a = Buffer.from(token); const b = Buffer.from(expected);
    // Compare byte lengths, not string lengths: a non-ASCII token of the right length would make timingSafeEqual throw.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { csrfToken, checkCsrf };
