'use strict';

/**
 * OpenVibe.AI seam (optional): run news.summarize_story or news.compare_perspectives over a story's
 * source items and turn the result into a DRAFT revision with AI authorship. Nothing here publishes:
 * the story's publish step refuses an AI revision until a person records an approving review.
 *
 *   POST {OV_AI_INTERNAL_URL}/api/v1/runs?wait=…  { workflow, input: { topic, sources } }
 *   (service token for audience openvibe.ai, capability ai.run.create, namespace news)
 *
 * Only what News itself stores goes to the model: headline, URL, outlet, authors, dates and the
 * licensed short summary. Article bodies are never stored, so they can never be sent.
 * Claims the model does not cite are dropped (and listed as gaps), never kept uncited; a failed or
 * unfinished run produces no text at all.
 */
const { serviceAuth } = require('openvibe-contracts');

const WORKFLOWS = ['news.summarize_story', 'news.compare_perspectives'];

class AiError extends Error {
    constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

function createAi({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.ai.internalUrl && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create', fetchImpl,
    }) : null;

    /** sources: [{ id (nsi_…), sources_item_id, headline, url, outlet, authors, published_at, retrieved_at, summary }] in citation order. */
    async function run(workflow, { topic, sources }) {
        if (!enabled) throw new AiError('ai.not_configured', 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL)', 503);
        if (!WORKFLOWS.includes(workflow)) throw new AiError('ai.unknown_workflow', `workflow must be one of ${WORKFLOWS.join(', ')}`, 422);
        const input = {
            ...(topic ? { topic: String(topic).slice(0, 300) } : {}),
            sources: sources.slice(0, 50).map((s) => ({
                source_type: 'news.article', source_id: s.sources_item_id, title: s.headline, ...(s.url ? { url: s.url } : {}),
                ...(s.authors && s.authors.length ? { author: s.authors.join(', ').slice(0, 200) } : {}),
                ...(s.published_at ? { published_at: s.published_at } : {}), ...(s.retrieved_at ? { retrieved_at: s.retrieved_at } : {}),
                ...(s.summary ? { snippet: s.summary } : {}),
                provenance: { outlet: s.outlet, news_item: s.id },
            })),
        };
        let res;
        try {
            res = await fetchImpl(`${config.ai.internalUrl}/api/v1/runs?wait=${config.ai.waitMs}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({ workflow, input }),
                signal: AbortSignal.timeout(config.ai.waitMs + 5000),
            });
        } catch (err) {
            throw new AiError('ai.unavailable', `OpenVibe.AI is unreachable: ${err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok && res.status !== 202) throw new AiError(`ai.http_${res.status}`, `OpenVibe.AI answered ${res.status}${body && body.code ? ` (${body.code})` : ''}`);
        const r = body && body.run;
        if (!r || r.status !== 'succeeded' || !r.output || typeof r.output !== 'object') {
            throw new AiError('ai.no_result', `The ${workflow} run did not finish with a result (${r ? r.status : 'no run'}); no draft was made`);
        }
        return {
            runId: String(r.id), workflow: { id: workflow, runId: String(r.id), version: r.workflow && r.workflow.version != null ? r.workflow.version : undefined, model: r.provenance && r.provenance.model ? r.provenance.model : undefined },
            stub: Boolean(r.synthetic), output: r.output,
        };
    }

    return { enabled, WORKFLOWS, run };
}

/**
 * Turn a workflow output into paragraphs that each cite source item ids. citations are indexes
 * into the sources array sent. Uncited or out-of-range claims are dropped and reported as gaps.
 * → { headline, paragraphs: [{ text, sources }], gaps: [] }
 */
function draftFromOutput(workflow, output, sourceIds) {
    const gaps = Array.isArray(output.gaps) ? output.gaps.map(String).slice(0, 20) : [];
    const cite = (list) => [...new Set((Array.isArray(list) ? list : []).filter((n) => Number.isInteger(n) && n >= 0 && n < sourceIds.length).map((n) => sourceIds[n]))];
    const paragraphs = [];
    const add = (textValue, citations, what) => {
        const t = String(textValue || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const s = cite(citations);
        if (!s.length) { gaps.push(`dropped an uncited ${what}: "${t.slice(0, 120)}"`); return; }
        paragraphs.push({ text: t.slice(0, 2000), sources: s });
    };
    if (workflow === 'news.summarize_story') {
        add(output.summary, output.citations, 'summary');
        for (const k of Array.isArray(output.key_points) ? output.key_points : []) add(k && k.text, k && k.citations, 'key point');
        for (const t of Array.isArray(output.timeline) ? output.timeline : []) if (t && t.what) add(`${t.when ? `${t.when}: ` : ''}${t.what}`, t.citations, 'timeline entry');
    } else {
        for (const p of Array.isArray(output.perspectives) ? output.perspectives : []) if (p) add(`${p.label ? `${p.label}: ` : ''}${p.summary || ''}`, p.citations, 'perspective');
        for (const a of Array.isArray(output.agreements) ? output.agreements : []) add(a && a.text, a && a.citations, 'agreement');
        for (const d of Array.isArray(output.disagreements) ? output.disagreements : []) add(d && d.text, d && d.citations, 'disagreement');
    }
    const headline = typeof output.headline === 'string' && output.headline.trim() ? output.headline.trim().slice(0, 200)
        : typeof output.question === 'string' && output.question.trim() ? output.question.trim().slice(0, 200) : null;
    return { headline, paragraphs, gaps };
}

module.exports = { createAi, draftFromOutput, AiError, WORKFLOWS };
