'use strict';
/**
 * Every dependency pinned to a GitHub tag carries the sha512 its tarball hashes to. A hand-edited
 * bump of a codeload pin can silently drop that line (the Reviews layout PR did), so the entry is
 * checked here instead of being noticed only when a sibling copies the missing hash.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');

(async () => {
    await check('every codeload dependency in package-lock.json pins a sha512 integrity', () => {
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        const missing = Object.entries(lock.packages || {})
            .filter(([, p]) => typeof p.resolved === 'string' && p.resolved.startsWith('https://codeload.github.com/'))
            .filter(([, p]) => !p.integrity)
            .map(([name, p]) => `${name}@${p.version || '?'}`);
        assert.deepStrictEqual(missing, [], `lock entries without integrity: ${missing.join(', ')}`);
    });

    done();
})();
