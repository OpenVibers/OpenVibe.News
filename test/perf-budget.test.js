'use strict';
// Size budgets for openvibe.news's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above the
// measurement below; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 46, // 46 openvibe-shared v4.249.0 (2026-11-14: measured 45.7, raised by pin-bump from 45.5); 45.5 openvibe-shared v4.248.0 (2026-11-14: measured 45.1, raised by pin-bump from 45); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 43.2 with openvibe-shared 4.93.2: content labels, glyph fallback, footer counts (2026-11-01); 42.5 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 41.5 with the phone pick blocks (2026-10-30); 36.2 Shared 4.15.1 footer; 33.2 on 2026-10-22: the front page's topics (12 cards), steps, questions (and their FAQPage and topics ItemList JSON-LD) and links; 24.4 with the home showcase (17.4 before it; fresh database)
    htmlBrotliKB: 10.5,   // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 9.5 with the phone pick blocks (2026-10-30); 8.0 (2026-10-22 the richer front page); 6.3 (4.5 before the showcase)
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime, 2026-10-04)
    jsRawKB: 394.5, // 394.5: measured 394.1 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 2,   // 2 (news.css + showcase.css, home page 1 only)
    cssRawKB: 56, // 56: 55.5 + 0.5 for the breadcrumb chevron drawn as a mask (design rule 169, 2026-11-14); 55.5 openvibe-shared v4.248.0 (2026-11-14: measured 55.2, raised by pin-bump from 53); 53 openvibe-shared v4.229.0 (2026-11-12: measured 52.7, raised by pin-bump from 44); 43.4 with the phone pick rules and the shipped fold (2026-10-30); 40.3 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 38.5 touch targets on phones (2026-10-29); 33.6 openvibe-shared 4.26.1 (hero visual); 28.1 with Shared 4.13.0 (2026-10-26); 22.2 on 2026-10-22 (the front page's numbers, brief cards, topics, outlets, questions and links); 18.2 with the front page aligned to the showcase (2026-10-15); 15.5 (5.2 before showcase.css)
    cssBrotliKB: 10.5, // 10.5: measured 10.2 with the chevron mask and 4.248.0 (2026-11-14); 10 openvibe-shared v4.229.0 (2026-11-12: measured 9.6, raised by pin-bump from 9.5); 9.2 with the phone pick rules and the shipped fold (2026-10-30); 8.2 touch targets on phones (2026-10-29); 6.2 with Shared 4.13.0 (2026-10-26); 5.2 (2026-10-22); 3.9 (1.4 before showcase.css)
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', NEWS_PGLITE_DIR: pgliteDir,
            NEWS_WORKER: 'off', OV_OAUTH_CLIENT_SECRET: 'test-secret', NEWS_FORM_SECRET: 'test-form-secret',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (NEWS_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
