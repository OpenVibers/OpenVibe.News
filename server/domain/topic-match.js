'use strict';
/**
 * Which topics a wire cluster belongs to, so a topic page carries the AI briefs and reports on it (not only the
 * stories editors filed under it). Deterministic and explainable, like clustering:
 *
 *   a source can place everything it reports (NASA's releases are Space, NIST's Science, the FDA's recalls and the
 *   CDC's newsroom Health, the Federal Reserve Board's releases Business);
 *   otherwise a topic's words must appear: once in the cluster's label, or twice (two different words) across the
 *   label and its reports' headlines.
 *
 *   topicsFor({ label, headlines, sources }) → [slug, …]   (several topics can match; none is fine)
 */
const RULES = Object.freeze({
    space: { sources: ['nasa-news-releases'], words: ['nasa', 'spacecraft', 'astronaut', 'astronauts', 'orbit', 'orbital', 'rocket', 'mars', 'moon', 'lunar', 'satellite', 'satellites', 'telescope', 'space station', 'asteroid', 'artemis', 'esa', 'spaceflight', 'launch site', 'uk space agency'] },
    science: { sources: ['nist-news'], words: ['research', 'researchers', 'scientists', 'scientific', 'science', 'study', 'discovery', 'physics', 'chemistry', 'biology', 'laboratory', 'genome', 'fossil', 'quantum', 'experiment'] },
    health: { sources: ['fda-food-recalls', 'cdc-newsroom'], words: ['health', 'hospital', 'hospitals', 'nhs', 'disease', 'vaccine', 'vaccines', 'virus', 'outbreak', 'cancer', 'medicine', 'medicines', 'medical', 'patients', 'mental health', 'food safety', 'allergen', 'salmonella', 'listeria', 'recall', 'pharmaceutical', 'care homes', 'gp'] },
    climate: { words: ['climate', 'emissions', 'net zero', 'carbon', 'flood', 'flooding', 'floods', 'heatwave', 'drought', 'wildfire', 'wildfires', 'storm', 'environment', 'environmental', 'renewable', 'renewables', 'wind farm', 'solar', 'biodiversity', 'pollution', 'energy transition', 'green'] },
    business: { sources: ['federal-reserve-press'], words: ['economy', 'economic', 'business', 'businesses', 'trade', 'tariff', 'tariffs', 'market', 'markets', 'investment', 'investors', 'inflation', 'jobs', 'employment', 'industry', 'industrial', 'budget', 'tax', 'taxes', 'bank', 'banks', 'competition', 'merger', 'consumers', 'retail', 'exports', 'growth', 'small firms'] },
    security: { words: ['cyber', 'cybersecurity', 'cyber security', 'hacker', 'hackers', 'hacked', 'ransomware', 'vulnerability', 'vulnerabilities', 'data breach', 'breach', 'malware', 'phishing', 'ncsc', 'cisa', 'enisa', 'fraud', 'scam', 'scams'] },
    technology: { words: ['technology', 'tech', 'digital', 'artificial intelligence', 'ai', 'software', 'semiconductor', 'semiconductors', 'chips', 'broadband', '5g', 'computing', 'robotics', 'data centre', 'data centres', 'data center', 'innovation', 'startups'] },
    'internet-policy': { words: ['online safety', 'digital services act', 'digital markets act', 'data protection', 'gdpr', 'privacy', 'net neutrality', 'online platforms', 'ofcom', 'copyright', 'content moderation', 'encryption', 'disinformation', 'age verification'] },
    'open-source': { words: ['open source', 'open-source', 'linux', 'open standards', 'open data', 'github'] },
    games: { words: ['video game', 'video games', 'videogame', 'gaming', 'esports', 'playstation', 'xbox', 'nintendo', 'steam'] },
    streaming: { words: ['streaming', 'streamer', 'streamers', 'twitch', 'youtube', 'netflix', 'broadcaster', 'broadcasting', 'tv licence', 'live stream', 'livestream'] },
    world: { sources: ['eu-press-corner'], words: ['international', 'foreign', 'ukraine', 'russia', 'china', 'united nations', 'nato', 'g7', 'g20', 'summit', 'ambassador', 'embassy', 'diplomatic', 'refugees', 'humanitarian', 'middle east', 'gaza', 'israel', 'africa', 'india', 'sanctions', 'ceasefire'] },
});

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MATCHERS = Object.fromEntries(Object.entries(RULES).map(([slug, r]) => [slug, {
    sources: new Set(r.sources || []),
    words: r.words.map((w) => ({ w, re: new RegExp(`(?:^|[^a-z0-9])${escape(w)}(?:[^a-z0-9]|$)`, 'i') })),
}]));

function topicsFor({ label = '', headlines = [], sources = [] } = {}) {
    const lab = String(label || '');
    const all = `${lab}\n${headlines.slice(0, 12).join('\n')}`;
    const out = [];
    for (const [slug, m] of Object.entries(MATCHERS)) {
        if (sources.some((s) => m.sources.has(s))) { out.push(slug); continue; }
        if (m.words.some(({ re }) => re.test(lab))) { out.push(slug); continue; }
        let hits = 0;
        for (const { re } of m.words) { if (re.test(all) && ++hits >= 2) break; }
        if (hits >= 2) out.push(slug);
    }
    return out;
}

module.exports = { topicsFor, RULES };
