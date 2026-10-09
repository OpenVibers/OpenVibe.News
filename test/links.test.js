'use strict';
/**
 * A source's link reaches a public page only when it is http(s): a publisher's javascript: or data: URL (it arrives
 * through OpenVibe.Sources) is never a clickable link. Pre-launch review, 2026-10-09.
 */
const assert = require('assert');
const { httpHref } = require('../server/render/pages');

assert.strictEqual(httpHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
assert.strictEqual(httpHref('http://example.com/'), 'http://example.com/');
for (const bad of ['javascript:alert(document.domain)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '/relative', '', null, undefined]) {
    assert.strictEqual(httpHref(bad), null, `${JSON.stringify(bad)} is not a link`);
}
console.log('links: only http(s) source URLs become links');
