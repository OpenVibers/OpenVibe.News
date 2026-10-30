'use strict';
/**
 * ADR-033: News' part of an account export and deletion, through the signed POST /internal/events route. A person's
 * drafts and cached profile are exported and erased; the story they opened and its byline stay as the publication's
 * record; Bo's rows stay. The guard fails on a new table with a person column that is neither covered nor exempted.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { TABLES } = require('../server/account-data');

const SECRET = `whsec_${'fixture'.repeat(6)}`;
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';

(async () => {
    const calls = [];
    const accountSend = async (path, body) => { calls.push({ path, body }); return { ok: true, status: 201 }; };
    const t = await boot({ env: { NEWS_EVENTS_SECRET: SECRET }, accountSend });
    const db = t.ctx.store.db;
    const deliver = async (event) => {
        const raw = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    try {
        await check('every table that names a person is covered or exempted with a reason', async () => {
            const missing = await uncovered(db, {
                tables: TABLES,
                exempt: {
                    account_data_events: 'the ledger of requests itself: which export and deletion News applied',
                    news_index_revisions: "owner is the search-index document's owner (type/id), not a person; the row holds a revision and hash",
                },
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        });

        await check('an export carries drafts and profile; a deletion erases them and keeps the editorial record with its byline', async () => {
            for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
                await db.exec("INSERT INTO news_stories (id, slug, working_headline, state, created_by, created_at, updated_at) VALUES ($1, $2, $3, 'published', $4, 1, 1)", [`sty_${name}`, `story-${name}`, `headline ${name}`, subject]);
                await db.exec("INSERT INTO news_story_drafts (entity_id, owner, base_revision, content, fields, meta, created_at, updated_at) VALUES ($1, $2, 0, 'draft', '{}', '{}', 1, 1)", [`sty_${name}`, subject]);
                await db.exec('INSERT INTO subject_projections (subject, username, display_name, refreshed_at) VALUES ($1, $2, $2, 1)', [subject, name]);
            }
            const exp = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EXP', subject: A }));
            assert.deepStrictEqual([exp.status, exp.json.outcome], [200, 'exported']);
            const part = calls.find((c) => c.path === '/internal/account-exports/exp_01JZ0000000000000000000EXP/parts');
            assert.ok(part, 'the part was pushed');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            assert.strictEqual(files['story-drafts.json'].length, 1);
            assert.strictEqual(files['stories.json'].length, 1);
            assert.strictEqual(files['profile.json'].length, 1);
            assert.ok(!JSON.stringify(part.body).includes(B), 'nobody else\'s rows');

            const del = await deliver(ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DEX', subject: A, aliases: [] }));
            assert.deepStrictEqual([del.status, del.json.outcome], [200, 'erased']);
            assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM news_story_drafts WHERE owner = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM subject_projections WHERE subject = $1', [A])), 0);
            assert.strictEqual(await db.value('SELECT created_by FROM news_stories WHERE id = $1', ['sty_ada']), A, 'the published story keeps its byline');
            assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM news_story_drafts WHERE owner = $1', [B])), 1);
            const confirmation = calls.find((c) => c.path === '/internal/account-deletions/del_01JZ0000000000000000000DEX/confirmations');
            assert.ok(confirmation, 'the confirmation was sent');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
