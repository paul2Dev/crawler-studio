const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { loadRobotsPolicy } = require('./robots');
const { normalizeUrl, isSameHost } = require('./url-utils');

const DEFAULT_UA = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class SiteProfiler {
    constructor(options, onProgress = () => { }) {
        this.options = {
            maxPagesProbe: 300,
            maxDepthProbe: 8,
            delayMinMs: 300,
            delayMaxMs: 900,
            pageTimeoutMs: 35000,
            settleMs: 900,
            respectRobots: true,
            saveExternalAssets: false,
            ...options,
        };
        this.onProgress = onProgress;
        this.stopRequested = false;
        this.browser = null;
        this.context = null;
    }

    requestStop() {
        this.stopRequested = true;
        if (this.context) {
            this.context.close().catch(() => { });
        }
        if (this.browser) {
            this.browser.close().catch(() => { });
        }
    }

    ensureNotStopped() {
        if (this.stopRequested) {
            const err = new Error('Dry run oprit manual de utilizator.');
            err.code = 'JOB_STOPPED';
            throw err;
        }
    }

    async run() {
        const startUrl = normalizeUrl(this.options.startUrl);
        const origin = new URL(startUrl).origin;

        const robots = this.options.respectRobots
            ? await loadRobotsPolicy(origin, this.options.userAgent)
            : { found: false, canFetch: () => true, crawlDelayMs: 0 };

        this.onProgress({
            level: 'info',
            message: robots.found
                ? `Dry run: robots.txt incarcat (${robots.robotsUrl})`
                : 'Dry run: robots.txt indisponibil, folosesc limite conservative.',
        });

        this.browser = await chromium.launch({ headless: true });
        this.context = await this.browser.newContext({
            userAgent: this.options.userAgent,
            viewport: { width: rand(1280, 1580), height: rand(760, 980) },
            locale: 'ro-RO',
        });

        const queue = [{ url: startUrl, depth: 0 }];
        const visited = new Set();
        const discovered = new Set([startUrl]);
        const depthHistogram = new Map();

        let maxObservedDepth = 0;
        let failedPages = 0;

        try {
            while (queue.length && visited.size < this.options.maxPagesProbe) {
                this.ensureNotStopped();
                const { url, depth } = queue.shift();
                const currentUrl = normalizeUrl(url);

                if (visited.has(currentUrl)) continue;
                if (depth > this.options.maxDepthProbe) continue;
                if (!robots.canFetch(currentUrl)) continue;

                visited.add(currentUrl);
                maxObservedDepth = Math.max(maxObservedDepth, depth);
                depthHistogram.set(depth, (depthHistogram.get(depth) || 0) + 1);

                this.onProgress({
                    level: 'info',
                    message: `Dry run: analizez ${visited.size}/${this.options.maxPagesProbe} - depth ${depth} - ${currentUrl}`,
                });

                const page = await this.context.newPage();

                try {
                    this.ensureNotStopped();
                    await page.goto(currentUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: this.options.pageTimeoutMs,
                    });

                    this.ensureNotStopped();
                    await page.waitForTimeout(this.options.settleMs);
                    this.ensureNotStopped();
                    const html = await page.content();
                    const links = this.extractLinks(html, currentUrl, startUrl);

                    for (const link of links) {
                        if (!discovered.has(link)) {
                            discovered.add(link);
                            queue.push({ url: link, depth: depth + 1 });
                        }
                    }
                } catch {
                    failedPages += 1;
                } finally {
                    await page.close();
                }

                this.ensureNotStopped();
                const jitter = rand(this.options.delayMinMs, this.options.delayMaxMs);
                await sleep(Math.max(jitter, robots.crawlDelayMs || 0));
            }
        } finally {
            if (this.context) {
                await this.context.close().catch(() => { });
            }
            if (this.browser) {
                await this.browser.close().catch(() => { });
            }
            this.context = null;
            this.browser = null;
        }

        this.ensureNotStopped();

        const pagesDiscovered = discovered.size;
        const pagesVisited = visited.size;

        const recommendedMaxDepth = Math.max(2, Math.min(12, maxObservedDepth + 1));
        const recommendedMaxPages = Math.max(60, Math.ceil(pagesDiscovered * 1.2));

        return {
            mode: 'dry-run',
            analyzedStartUrl: startUrl,
            pagesVisited,
            pagesDiscovered,
            failedPages,
            maxObservedDepth,
            depthHistogram: Object.fromEntries([...depthHistogram.entries()].sort((a, b) => a[0] - b[0])),
            recommendations: {
                maxDepth: recommendedMaxDepth,
                maxPages: recommendedMaxPages,
            },
            probeLimits: {
                maxPagesProbe: this.options.maxPagesProbe,
                maxDepthProbe: this.options.maxDepthProbe,
            },
        };
    }

    extractLinks(html, currentUrl, startUrl) {
        const $ = cheerio.load(html);
        const links = new Set();

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;

            try {
                const absolute = normalizeUrl(new URL(href, currentUrl).toString());
                if (isSameHost(startUrl, absolute)) links.add(absolute);
            } catch {
                // Ignore malformed URLs.
            }
        });

        return [...links];
    }
}

function buildProfilerOptions(input) {
    return {
        startUrl: input.targetUrl,
        maxPagesProbe: input.maxPagesProbe,
        maxDepthProbe: input.maxDepthProbe,
        delayMinMs: input.delayMinMs,
        delayMaxMs: input.delayMaxMs,
        respectRobots: input.respectRobots,
        saveExternalAssets: input.saveExternalAssets,
        userAgent: DEFAULT_UA[rand(0, DEFAULT_UA.length - 1)],
    };
}

module.exports = {
    SiteProfiler,
    buildProfilerOptions,
};
