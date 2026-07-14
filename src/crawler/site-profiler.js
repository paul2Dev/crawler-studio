const { chromium } = require('playwright');

const { loadRobotsPolicy } = require('./robots');
const {
    normalizeUrl,
    isSameHost,
    isLikelyDownloadUrl,
    isLikelyAjaxDataUrl,
    shouldSkipLinkForCrawl,
} = require('./url-utils');

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
            delayMinMs: 120,
            delayMaxMs: 260,
            pageTimeoutMs: 35000,
            settleMs: 250,
            respectRobots: true,
            saveExternalAssets: false,
            crawlDelayMinMs: 700,
            crawlDelayMaxMs: 1500,
            auth: { enabled: false },
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
        const startedAtMs = Date.now();
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

        await this.authenticateIfNeeded(startUrl);

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
                    const links = await this.collectLinksFromPage(page, currentUrl, startUrl);

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
        const dryRunDurationMs = Date.now() - startedAtMs;

        const recommendedMaxDepth = Math.max(2, Math.min(12, maxObservedDepth + 1));
        const recommendedMaxPages = Math.max(60, Math.ceil(pagesDiscovered * 1.2));
        const estimatedCrawlTime = this.estimateRealCrawlTime(pagesDiscovered);

        return {
            mode: 'dry-run',
            analyzedStartUrl: startUrl,
            pagesVisited,
            pagesDiscovered,
            failedPages,
            maxObservedDepth,
            dryRunDurationMs,
            discoveredLinks: [...discovered].sort((a, b) => a.localeCompare(b)),
            estimatedCrawlTime,
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

    async authenticateIfNeeded(startUrl) {
        const auth = this.options.auth;
        if (!auth || auth.enabled !== true) {
            return;
        }

        const loginUrl = normalizeUrl(auth.loginUrl || startUrl);
        const openModalSelector = String(auth.openModalSelector || '').trim();
        const confirmSelector = String(auth.confirmSelector || '').trim();
        const usernameSelector = String(auth.usernameSelector || '').trim();
        const passwordSelector = String(auth.passwordSelector || '').trim();
        const submitSelector = String(auth.submitSelector || '').trim();
        const successUrlContains = String(auth.successUrlContains || '').trim();
        const waitAfterLoginMs = Math.max(0, Number(auth.waitAfterLoginMs) || 1200);

        this.onProgress({
            level: 'info',
            message: `Dry run: pornesc autentificarea in sesiune: ${loginUrl}`,
        });

        const loginPage = await this.context.newPage();

        try {
            await loginPage.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: this.options.pageTimeoutMs,
            });

            if (openModalSelector) {
                await loginPage.waitForSelector(openModalSelector, { timeout: this.options.pageTimeoutMs });
                await loginPage.click(openModalSelector);
            }

            if (confirmSelector) {
                await loginPage.waitForSelector(confirmSelector, { timeout: this.options.pageTimeoutMs });
                await loginPage.click(confirmSelector);
            }

            await loginPage.waitForSelector(usernameSelector, { timeout: this.options.pageTimeoutMs });
            await loginPage.fill(usernameSelector, String(auth.username || ''));

            await loginPage.waitForSelector(passwordSelector, { timeout: this.options.pageTimeoutMs });
            await loginPage.fill(passwordSelector, String(auth.password || ''));

            await loginPage.waitForSelector(submitSelector, { timeout: this.options.pageTimeoutMs });
            await loginPage.click(submitSelector);

            await loginPage.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => { });
            if (waitAfterLoginMs > 0) {
                await loginPage.waitForTimeout(waitAfterLoginMs);
            }

            if (successUrlContains && !String(loginPage.url() || '').includes(successUrlContains)) {
                throw new Error(`Login aparent finalizat, dar URL-ul nu contine "${successUrlContains}".`);
            }

            this.onProgress({
                level: 'info',
                message: 'Dry run: autentificare realizata, continui analiza in sesiune autentificata.',
            });
        } catch (error) {
            const wrapped = new Error(`Dry run: autentificare esuata: ${error.message}`);
            wrapped.code = 'AUTH_FAILED';
            throw wrapped;
        } finally {
            await loginPage.close().catch(() => { });
        }
    }

    async collectLinksFromPage(page, currentUrl, startUrl) {
        const hrefs = await page.$$eval('a[href]', (nodes) =>
            nodes
                .map((n) => n.getAttribute('href') || '')
                .filter((href) => href && !/^(#|mailto:|tel:|javascript:)/i.test(href)),
        );
        const links = new Set();

        for (const href of hrefs) {
            try {
                const absolute = normalizeUrl(new URL(href, currentUrl).toString());
                if (!isSameHost(startUrl, absolute)) continue;
                if (shouldSkipLinkForCrawl(absolute)) continue;
                if (isLikelyDownloadUrl(absolute)) continue;
                if (isLikelyAjaxDataUrl(absolute)) continue;
                links.add(absolute);
            } catch {
                // Ignore malformed URLs.
            }
        }

        return [...links];
    }

    estimateRealCrawlTime(pagesCount) {
        const pageOverheadMs = 1200; // Typical navigation/render overhead per page.
        const minPerPage = this.options.crawlDelayMinMs + pageOverheadMs;
        const maxPerPage = this.options.crawlDelayMaxMs + pageOverheadMs;
        const avgPerPage = Math.round((minPerPage + maxPerPage) / 2);

        const minSeconds = Math.round((pagesCount * minPerPage) / 1000);
        const maxSeconds = Math.round((pagesCount * maxPerPage) / 1000);
        const avgSeconds = Math.round((pagesCount * avgPerPage) / 1000);

        return {
            minSeconds,
            maxSeconds,
            avgSeconds,
            assumptions: {
                crawlDelayMinMs: this.options.crawlDelayMinMs,
                crawlDelayMaxMs: this.options.crawlDelayMaxMs,
                pageOverheadMs,
            },
        };
    }
}

function buildProfilerOptions(input) {
    return {
        startUrl: input.targetUrl,
        maxPagesProbe: input.maxPagesProbe,
        maxDepthProbe: input.maxDepthProbe,
        delayMinMs: input.delayMinMs,
        delayMaxMs: input.delayMaxMs,
        crawlDelayMinMs: input.crawlDelayMinMs,
        crawlDelayMaxMs: input.crawlDelayMaxMs,
        respectRobots: input.respectRobots,
        saveExternalAssets: input.saveExternalAssets,
        auth: input.auth,
        userAgent: DEFAULT_UA[rand(0, DEFAULT_UA.length - 1)],
    };
}

module.exports = {
    SiteProfiler,
    buildProfilerOptions,
};
