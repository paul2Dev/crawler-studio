const {
    normalizeUrl,
    isSameHost,
    shouldSkipLinkForCrawl,
    isLikelyDownloadUrl,
    isLikelyAjaxDataUrl,
} = require('./url-utils');

function decodeXmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function extractLocValues(xmlText) {
    const locs = [];
    const regex = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
        const raw = decodeXmlEntities(match[1]).trim();
        if (raw) locs.push(raw);
    }
    return locs;
}

function isXmlLikelySitemapIndex(xmlText) {
    return /<\s*sitemapindex\b/i.test(String(xmlText || ''));
}

async function fetchWithTimeout(url, timeoutMs, userAgent) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: ac.signal,
            headers: {
                'User-Agent': userAgent || 'CrawlerStudio/1.0 (+https://localhost)',
                Accept: 'application/xml,text/xml,text/plain,*/*',
            },
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} la descarcare sitemap.`);
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

async function parseSitemapUrls(sitemapUrl, options = {}) {
    const maxSitemaps = Math.max(1, Number(options.maxSitemaps) || 40);
    const maxUrls = Math.max(1, Number(options.maxUrls) || 20000);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
    const keepCrossHost = options.keepCrossHost === true;
    const preferredHostUrl = String(options.preferredHostUrl || '').trim();
    const userAgent = String(options.userAgent || '').trim();

    const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
    const seedOrigin = new URL(normalizedSitemapUrl).origin;
    const preferredOrigin = (() => {
        if (!preferredHostUrl) return '';
        try {
            return new URL(preferredHostUrl).origin;
        } catch {
            return '';
        }
    })();

    const pendingSitemaps = [normalizedSitemapUrl];
    const seenSitemaps = new Set();
    const pageUrls = new Set();

    while (pendingSitemaps.length && seenSitemaps.size < maxSitemaps && pageUrls.size < maxUrls) {
        const currentSitemap = normalizeUrl(pendingSitemaps.shift());
        if (seenSitemaps.has(currentSitemap)) continue;
        seenSitemaps.add(currentSitemap);

        let xml;
        try {
            xml = await fetchWithTimeout(currentSitemap, timeoutMs, userAgent);
        } catch {
            continue;
        }

        const locs = extractLocValues(xml);
        if (locs.length === 0) continue;

        const isIndex = isXmlLikelySitemapIndex(xml);
        for (const loc of locs) {
            let absolute;
            try {
                absolute = normalizeUrl(new URL(loc, currentSitemap).toString());
            } catch {
                continue;
            }

            if (preferredOrigin) {
                if (!isSameHost(preferredOrigin, absolute)) continue;
            } else if (!keepCrossHost && !isSameHost(seedOrigin, absolute)) {
                continue;
            }

            if (isIndex || /\.xml(?:$|[?#])/i.test(absolute)) {
                if (!seenSitemaps.has(absolute) && pendingSitemaps.length < maxSitemaps * 2) {
                    pendingSitemaps.push(absolute);
                }
                continue;
            }

            if (shouldSkipLinkForCrawl(absolute)) continue;
            if (isLikelyDownloadUrl(absolute)) continue;
            if (isLikelyAjaxDataUrl(absolute)) continue;
            pageUrls.add(absolute);
            if (pageUrls.size >= maxUrls) break;
        }
    }

    return {
        sitemapUrl: normalizedSitemapUrl,
        urls: [...pageUrls],
        stats: {
            sitemapsProcessed: seenSitemaps.size,
            urlsDiscovered: pageUrls.size,
            cappedByMaxUrls: pageUrls.size >= maxUrls,
            maxUrls,
            maxSitemaps,
        },
    };
}

module.exports = {
    parseSitemapUrls,
};
