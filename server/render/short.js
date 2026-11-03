'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickList()   a list on the front page: a rail you swipe on a phone, every item shown (2026-10-31).
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio
 *                inputs and :has(), no script: every block stays in the page for crawlers, and a wider screen (or a
 *                browser without :has()) shows them all and no chips.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in public/css/home.css; the rule that shows the picked block is written for the page,
 * because there is one per block.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A list on the front page (the owner, 2026-10-31: never hide content to shorten a page). On a phone it is a rail you
 * swipe, every item in it; a wider screen shows the list as before. It used to be one item at a time, picked with a
 * row of radio chips, the rest display:none (21 items hidden on the 11-03 home). `labels` is kept for the callers and
 * no longer drawn: the list's own heading names it.
 *
 *   pickList({ key, label, head, labels, html })
 */
function pickList({ key, labels, html }) {
    if (!labels.length) return '';
    return `<div class="pick pick--rail" id="pick-${esc(key)}">${html}</div>`;
}

/** No longer needed (every item shows): kept so a caller that still asks for the rules gets none. */
function pickListRule() { return ''; }
function pickListRules() { return ''; }

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone the
 * heading gives way to the chip that names it.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes }) {
    if (!panes.length) return '';
    const chips = panes.map((p, i) => `<input type="radio" name="pick-${esc(key)}" id="pk-${esc(key)}-${esc(p.id)}" value="${esc(p.id)}"${i === 0 ? ' checked' : ''}><label for="pk-${esc(key)}-${esc(p.id)}">${esc(p.label)}</label>`).join('');
    const body = panes.map((p) => `<div class="pick-pane" id="pp-${esc(key)}-${esc(p.id)}">${p.html}</div>`).join('');
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head"><h2>${esc(head || label)}</h2></div><div class="pick-row" role="radiogroup" aria-label="${esc(label)}">${chips}</div></div><div class="pick-body">${body}</div></div>`;
}

/** The rule that shows the picked block of a pick block: one per block, so the CSS is written for the page. */
function pickRule(key, id) {
    return `.pick:has(#pk-${key}-${id}:checked) #pp-${key}-${id}{display:block}`;
}

/** The rules for every block of a pick block, in the order they appear. */
function pickRules(key, ids) {
    return ids.map((id) => pickRule(key, id)).join('');
}

/**
 * What a fold holds, counted, for its title row (the owner, 2026-10-31: a fold that shortens a page shows its count):
 * "6 questions", "12 items", "latest 5" for the shipped list, or nothing when there is nothing to count. Replaces the
 * old "tap to open".
 */
function foldMeta(body, cls = '') {
    const s = typeof body === 'string' ? body : String((body && (body.s || body.html || body.value)) || body || '');
    const n = (re) => (s.match(re) || []).length;
    const shipped = /data-ov-shipped="list"[^>]*?data-limit="(\d+)"|data-limit="(\d+)"[^>]*?data-ov-shipped="list"/.exec(s);
    const q = n(/<details[\s>]/g), li = n(/<li[\s>]/g), a = n(/<a\s/g);
    const text = shipped ? `latest ${shipped[1] || shipped[2]}` : q > 1 ? `${q} questions` : li > 1 ? `${li} items` : a > 1 ? `${a} links` : '';
    return text ? `<span${cls ? ` class="${cls}"` : ''}>${text}</span>` : '';
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="nh-fold nh-fold-block" id="${esc(id)}" open><summary>${head}${foldMeta(html)}</summary>${html}</details>${foldScript(id)}`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

module.exports = { pickBlock, pickRule, pickRules, pickList, pickListRule, pickListRules, foldBlock, foldMeta, foldScript };
