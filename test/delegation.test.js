'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else (here: a News editor) is refused
 * (403 subject.not_delegated), and so are sandbox tokens (401 token.sandbox_refused). First-party
 * services (svc:…) still name the person they act for.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';

(async () => {
    const t = await boot();
    const reader = t.network.addUser('reader');
    const caps = ['news.topic.manage', 'news.story.create'];
    const token = (sub, actorType, extra) => t.network.signService({ sub, actorType, aud: ['openvibe.news'], cap: caps, extra });
    const topicsNamed = (name) => t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM news_topics WHERE name = ?').get(name).n;
    const newTopic = (as, name, headers) => t.get('/api/v1/topics', { as, headers, json: { name } });

    await check('an app or module cannot act as an editor by naming them in X-OV-Subject', async () => {
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            for (const extra of [{ on_behalf_of: reader.subject }, {}]) {
                const r = await newTopic(token(sub, type, extra), `Planted by ${type}`, { 'x-ov-subject': t.editor.subject });
                assert.strictEqual(r.status, 403, `${type} ${JSON.stringify(extra)}: ${r.text}`);
                assert.strictEqual(r.json().code, 'subject.not_delegated');
                assert.strictEqual(topicsNamed(`Planted by ${type}`), 0);
            }
        }
    });

    await check('an app acts for its on_behalf_of person, with that person\'s rights', async () => {
        let r = await newTopic(token(APP, 'app', { on_behalf_of: reader.subject }), 'Reader topic');
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'news.editor_required', 'acts as the reader, who is no editor');
        r = await newTopic(token(APP, 'app', { on_behalf_of: t.editor.subject }), 'Editor topic via app', { 'x-ov-subject': t.editor.subject });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('sandbox app tokens are refused', async () => {
        const r = await newTopic(token(APP, 'app', { on_behalf_of: t.editor.subject, env: 'sandbox' }), 'Sandbox topic');
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.sandbox_refused');
    });

    await check('first-party services still name the person they act for', async () => {
        const r = await newTopic(t.network.serviceToken('tools', caps), 'Editor topic via svc', { 'x-ov-subject': t.editor.subject });
        assert.strictEqual(r.status, 201, r.text);
    });

    await t.close();
    done();
})();
