'use strict';
/**
 * Community discussion is referenced, not duplicated: a published story's comments are the
 * OpenVibe.Community thread resolved once for EntityRef { service: 'news', type: 'story', id }.
 * News stores only the thread id (news_story_discussion_refs) and reads the thread from Community
 * on every render; a Community failure says comments are unavailable, never shows an empty or
 * invented thread. Drafts never get a thread; retracting, unpublishing or a removed source hides it
 * (community.comment.moderate, after the commit, best effort); members comment through a plain
 * form, as themselves (X-OV-Subject).
 */
const assert = require('assert');
const { boot, check, done, launchReports } = require('./helpers/boot');

const BODY = [
    'NASA launched the Europa Clipper spacecraft on a Falcon Heavy rocket from Kennedy Space Center, starting a cruise of several years toward Jupiter and its moon Europa. [1, 2]',
    'NASA expects the probe to reach the Jupiter system in 2030 and to fly past Europa many times to study the ocean scientists think lies beneath the ice. [2, 3]',
    'One outlet reported that the launch window was chosen to use a gravity assist from Mars on the way to the outer planets, according to mission planners. [1]',
].join('\n\n');

(async () => {
    const t = await boot();
    const reports = launchReports(t.sources);
    await t.pull();
    const clusterId = t.db().prepare('SELECT cluster_id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).cluster_id;
    const open = async (headline, body = BODY) => {
        const r = await t.api('/stories', { json: { cluster: clusterId, headline, topic: 'space', body } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().story;
    };
    const publish = async (s, body = {}) => { const r = await t.api(`/stories/${s.id}/publish`, { json: body }); assert.strictEqual(r.status, 200, r.text); return r; };
    const calls = (re, method) => t.community.calls.filter((c) => re.test(c.url.split('?')[0]) && (!method || c.method === method));
    const resolves = () => calls(/\/threads\/resolve$/, 'POST');
    const hides = () => calls(/\/visibility$/, 'PUT');
    const settle = () => t.ctx.discussion.idle();
    const refOf = (id) => t.db().prepare('SELECT * FROM news_story_discussion_refs WHERE entity_id = ?').get(id);
    t.community.setProbe(() => t.db().inTransaction);

    const story = await open('Europa Clipper is on its way to Jupiter');
    const url = `/stories/${story.slug}`;
    const member = t.network.addUser('reader', { display_name: 'Rita Reader' });

    await check('a draft has no thread: nothing is resolved while a story is unpublished', async () => {
        assert.strictEqual((await t.get(url)).status, 404);
        const prev = await t.get(`/edit/stories/${story.id}/preview`, { as: t.editor });
        assert.strictEqual(prev.status, 200, prev.text);
        assert.doesNotMatch(prev.text, /id="comments"/, 'the editor preview shows no thread');
        assert.strictEqual(resolves().length, 0);
        assert.strictEqual(refOf(story.id), undefined);
    });

    await check('a published story resolves its thread once, for the story’s EntityRef, and stores only the id', async () => {
        await publish(story);
        let page = await t.get(url);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<section id="comments" class="comments"/);
        assert.match(page.text, /No comments yet\./);
        assert.match(page.text, /Comments are hosted by <a href="https:\/\/openvibe\.community">OpenVibe\.Community<\/a>/);
        assert.match(page.text, /Sign in with OpenVibe<\/a> to comment/);
        assert.strictEqual(resolves().length, 1);
        const call = resolves()[0];
        assert.ok(call.cap.includes('community.comment.write'), 'resolved with the write capability');
        assert.deepStrictEqual(JSON.parse(call.body).ref, { service: 'news', type: 'story', id: story.id, label: 'Europa Clipper is on its way to Jupiter' });
        const ref = refOf(story.id);
        assert.strictEqual(ref.thread_id, '1');
        assert.deepStrictEqual(Object.keys(ref).sort(), ['entity_id', 'ref', 'resolved_at', 'thread_id'], 'the reference table has no room for comments');
        page = await t.get(url);
        await t.get(`${url}?group=outlet`);
        assert.strictEqual(resolves().length, 1, 'later renders reuse the stored id');
        assert.strictEqual(calls(/\/threads\/1$/, 'GET').length, 3, 'every render reads the thread from Community');
    });

    await check('a member comments through the plain form, as themselves; the comment lives in Community only', async () => {
        const csrf = t.csrf(member);
        let r = await t.get(`${url}/comments`, { form: { _csrf: csrf, message: 'Anonymous?' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), `/auth/login?next=${encodeURIComponent(url)}`);
        r = await t.get(`${url}/comments`, { as: member, form: { message: 'No token' } });
        assert.strictEqual(r.status, 403);
        const page = await t.get(url, { as: member });
        assert.match(page.text, new RegExp(`<form method="post" action="${url}/comments" class="comment-form">`));
        assert.match(page.text, new RegExp(`name="_csrf" value="${csrf}"`));
        assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
        r = await t.get(`${url}/comments`, { as: member, form: { _csrf: csrf, message: 'Great summary; the 2030 arrival <b>date</b> matters.\nThanks.' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(r.headers.get('location'), `${url}#comments`);
        const posted = calls(/\/threads\/1\/comments$/, 'POST');
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].subject, member.subject, 'commented as the member (X-OV-Subject)');
        assert.ok(posted[0].cap.includes('community.comment.write'));
        const after = await t.get(url);
        assert.match(after.text, /<strong>Rita Reader<\/strong>/);
        assert.match(after.text, /Great summary; the 2030 arrival &lt;b&gt;date&lt;\/b&gt; matters\.<br>Thanks\./, 'escaped, read from Community');
        const dump = t.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
            .map(({ name }) => JSON.stringify(t.db().prepare(`SELECT * FROM "${name}"`).all())).join('\n');
        assert.doesNotMatch(dump, /Great summary|2030 arrival/, 'no comment text is copied into News');
    });

    await check('Community down: the story still serves and says comments are unavailable — no empty or invented thread', async () => {
        t.community.setDown(true);
        const page = await t.get(url);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /NASA launched the Europa Clipper spacecraft/);
        assert.match(page.text, /Comments are unavailable/);
        assert.doesNotMatch(page.text, /No comments yet|Rita Reader|comment-form/);
        const r = await t.get(`${url}/comments`, { as: member, form: { _csrf: t.csrf(member), message: 'Lost?' } });
        assert.strictEqual(r.status, 502);
        assert.match(r.text, /Comment not posted/);
        t.community.setDown(false);
        const fresh = await open('A second Europa Clipper story');
        await publish(fresh);
        t.community.setDown(true);
        const p2 = await t.get(`/stories/${fresh.slug}`);
        assert.match(p2.text, /Comments are unavailable/);
        assert.strictEqual(refOf(fresh.id), undefined, 'a failed resolve stores no thread id');
        t.community.setDown(false);
    });

    await check('a removed source a paragraph rests on hides the thread after the commit; the fixed revision shows it again', async () => {
        const before = hides().length;
        t.sources.removeItem(reports.a.id, 'licence withdrawn by the publisher');
        const d = await t.deliver({ event_type: 'sources.item.removed', subject: { type: 'item', id: reports.a.id, revision: 2 }, payload: { item_id: reports.a.id, source_key: 'wire-a', category: 'news', revision: 2, reason: 'licence withdrawn by the publisher' } });
        assert.strictEqual(d.status, 204, d.text);
        await settle();
        const now = hides().slice(before);
        assert.strictEqual(now.length, 1, 'only the story that had a thread is hidden (the second one never resolved one)');
        assert.deepStrictEqual(JSON.parse(now[0].body), { visibility: 'hidden' });
        assert.strictEqual(now[0].url, '/api/v1/comments/threads/1/visibility');
        assert.ok(now[0].cap.includes('community.comment.moderate'), 'hidden with the moderate capability');
        assert.strictEqual(now[0].probe, false, 'called after the write committed, never inside the transaction');
        assert.strictEqual(t.community.threads.get(1).visibility, 'hidden');
        const reads = calls(/\/threads\/1$/, 'GET').length;
        const page = await t.get(url);
        assert.match(page.text, /Comments are paused while editors revise this story/);
        assert.doesNotMatch(page.text, /comment-form|Rita Reader/);
        assert.strictEqual(calls(/\/threads\/1$/, 'GET').length, reads, 'a closed story does not read its thread');
        const r = await t.get(`${url}/comments`, { as: member, form: { _csrf: t.csrf(member), message: 'Still here?' } });
        assert.strictEqual(r.status, 409);

        const itemA = t.db().prepare('SELECT id FROM news_source_items WHERE sources_item_id = ?').get(reports.a.id).id;
        assert.strictEqual((await t.api(`/stories/${story.id}/sources/${itemA}`, { method: 'DELETE' })).status, 200);
        const head = t.ctx.store.revisions.head(story.id).number;
        const fixed = BODY.split('\n\n').slice(0, 2).map((p) => p.replace('[1, 2]', '[2, 3]')).join('\n\n');
        let rr = await t.api(`/stories/${story.id}/revisions`, { json: { body: fixed, expected_revision: head } });
        assert.strictEqual(rr.status, 201, rr.text);
        await publish(story, { revision: rr.json().revision, correction: { kind: 'update', note: 'A source withdrew its report; the paragraph based only on it was removed.' } });
        await settle();
        assert.deepStrictEqual(JSON.parse(hides().pop().body), { visibility: 'public' });
        assert.strictEqual(t.community.threads.get(1).visibility, 'public');
        rr = await t.get(url);
        assert.match(rr.text, /Rita Reader/);
    });

    await check('retraction hides the thread and the retracted page shows none; unpublish hides, republish shows', async () => {
        // Source [1] (wire-a) was removed above, so this story rests on the two that remain.
        const other = await open('Europa Clipper: the launch in numbers', BODY.split('\n\n').slice(0, 2).map((p) => p.replace(/\[[\d, ]+\]$/, '[1, 2]')).join('\n\n'));
        await publish(other);
        await t.get(`/stories/${other.slug}`);
        const id = refOf(other.id).thread_id;
        let r = await t.api(`/stories/${other.id}/unpublish`, { json: {} });
        assert.strictEqual(r.status, 200, r.text);
        await settle();
        assert.strictEqual(t.community.threads.get(Number(id)).visibility, 'hidden');
        await publish(other);
        await settle();
        assert.strictEqual(t.community.threads.get(Number(id)).visibility, 'public');
        r = await t.api(`/stories/${other.id}/retract`, { json: { note: 'Our sources described a rehearsal, not the launch.' } });
        assert.strictEqual(r.status, 200, r.text);
        await settle();
        assert.strictEqual(t.community.threads.get(Number(id)).visibility, 'hidden');
        const last = hides().pop();
        assert.strictEqual(last.probe, false);
        const page = await t.get(`/stories/${other.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Comments are closed: this story was retracted\./);
        assert.doesNotMatch(page.text, /comment-form/);
    });

    await check('a write refused inside its transaction (rolled back) calls nothing', async () => {
        const n = hides().length;
        const r = await t.api(`/stories/${story.id}/publish`, { json: { revision: 2 } });
        assert.strictEqual(r.status, 409, 'revision 2 is the pending revision that still cites the removed source');
        assert.strictEqual(r.json().code, 'story.source_removed');
        await settle();
        assert.strictEqual(hides().length, n);
        assert.strictEqual(t.community.threads.get(1).visibility, 'public');
    });

    await t.close();
    done();
})();
