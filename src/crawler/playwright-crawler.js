const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { loadRobotsPolicy } = require('./robots');
const {
    normalizeUrl,
    isSameHost,
    isLikelyDownloadUrl,
    isLikelyAjaxDataUrl,
    shouldSkipLinkForCrawl,
    getSkipReasonForCrawl,
    htmlFileNameFor,
    resolveOutputAssetPath,
    safeRelativeLink,
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

function looksLikeAssetUrl(urlString) {
    try {
        const pathname = new URL(urlString).pathname || '';
        const ext = path.extname(pathname).toLowerCase();
        // Known page-like extensions should still be treated as pages.
        if (ext === '.html' || ext === '.htm') return false;
        // Any other extension is most likely a static asset or downloadable file.
        return ext.length > 0;
    } catch {
        return false;
    }
}

function normalizeHeaderValue(value) {
    return String(value || '').toLowerCase().split(';')[0].trim();
}

function isDownloadStartingError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('download is starting');
}

function detectMimeMismatch(urlString, contentType) {
    let ext = '';
    try {
        ext = path.extname(new URL(urlString).pathname || '').toLowerCase();
    } catch {
        return null;
    }

    if (!ext || !contentType) return null;

    const expectedByExt = {
        '.css': ['text/css'],
        '.js': ['application/javascript', 'text/javascript'],
        '.mjs': ['application/javascript', 'text/javascript'],
        '.json': ['application/json', 'text/json'],
        '.svg': ['image/svg+xml'],
        '.png': ['image/png'],
        '.jpg': ['image/jpeg'],
        '.jpeg': ['image/jpeg'],
        '.webp': ['image/webp'],
        '.gif': ['image/gif'],
        '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
        '.woff': ['font/woff'],
        '.woff2': ['font/woff2'],
        '.ttf': ['font/ttf', 'application/x-font-ttf'],
        '.otf': ['font/otf', 'font/ttf', 'application/font-sfnt'],
        '.mp4': ['video/mp4'],
        '.mp3': ['audio/mpeg'],
    };

    const expected = expectedByExt[ext];
    if (!expected || expected.length === 0) return null;

    const normalizedType = normalizeHeaderValue(contentType);
    if (!normalizedType || normalizedType === 'application/octet-stream') return null;

    const isExpected = expected.some((token) => normalizedType.includes(token));
    if (isExpected) return null;

    return {
        url: urlString,
        extension: ext,
        contentType: normalizedType,
        expected,
    };
}

class PlaywrightCrawler {
    constructor(options, onProgress = () => { }) {
        this.options = {
            maxPages: 150,
            maxDepth: 3,
            delayMinMs: 900,
            delayMaxMs: 2200,
            pageTimeoutMs: 45000,
            settleMs: 1300,
            respectRobots: true,
            saveExternalAssets: false,
            singlePage: false,
            domAssetDirectLimit: 180,
            domAssetDirectConcurrency: 6,
            directAssetTimeoutMs: 6000,
            auth: { enabled: false },
            ...options,
        };
        this.onProgress = onProgress;
        this.pageMap = new Map();
        this.assetMap = new Map();
        this.assetSourceByLocalPath = new Map();
        this.visited = new Set();
        this.failed = [];
        this.audit = {
            redirects: [],
            missingAssets: [],
            brokenInternalLinks: [],
            mimeMismatches: [],
        };
        this.auditSeen = {
            redirects: new Set(),
            missingAssets: new Set(),
            brokenInternalLinks: new Set(),
            mimeMismatches: new Set(),
        };
        this.stopRequested = false;
        this.browser = null;
        this.context = null;
    }

    addAuditEntry(kind, key, entry) {
        if (!this.auditSeen[kind].has(key)) {
            this.auditSeen[kind].add(key);
            this.audit[kind].push(entry);
        }
    }

    requestStop() {
        this.stopRequested = true;
        // Close context/browser to interrupt blocking operations (goto, waits).
        if (this.context) {
            this.context.close().catch(() => { });
        }
        if (this.browser) {
            this.browser.close().catch(() => { });
        }
    }

    ensureNotStopped() {
        if (this.stopRequested) {
            const err = new Error('Job oprit manual de utilizator.');
            err.code = 'JOB_STOPPED';
            throw err;
        }
    }

    enqueueDiscoveredLinks(queue, links, depth) {
        if (!Array.isArray(links) || links.length === 0) return;
        const normalizedDepth = Math.max(0, Number(depth) || 0);
        const queuedUrls = new Set(queue.map((item) => normalizeUrl(item.url)));

        for (const link of links) {
            if (!link) continue;
            const url = normalizeUrl(link);
            if (this.visited.has(url)) continue;
            if (queuedUrls.has(url)) continue;
            queue.push({ url, depth: normalizedDepth });
            queuedUrls.add(url);
        }
    }

    async run() {
        const startUrl = normalizeUrl(this.options.startUrl);
        const origin = new URL(startUrl).origin;

        await this.prepareDirs(this.options.outputDir);

        const robots = this.options.respectRobots
            ? await loadRobotsPolicy(origin, this.options.userAgent)
            : { found: false, canFetch: () => true, crawlDelayMs: 0 };

        this.onProgress({
            level: 'info',
            message: robots.found
                ? `robots.txt incarcat: ${robots.robotsUrl}`
                : 'robots.txt indisponibil, folosesc limite prudente.',
        });

        this.browser = await chromium.launch({ headless: true });
        this.context = await this.browser.newContext({
            userAgent: this.options.userAgent,
            viewport: { width: rand(1280, 1580), height: rand(760, 980) },
            locale: 'ro-RO',
        });

        await this.authenticateIfNeeded(startUrl);

        const queue = [{ url: startUrl, depth: 0 }];
        let ajaxExpansionDone = this.options.singlePage;

        try {
            while ((queue.length || !ajaxExpansionDone) && this.visited.size < this.options.maxPages) {
                if (!queue.length && !ajaxExpansionDone) {
                    const discoveredFromAjax = await this.processAjaxPayloadAssets(startUrl);
                    this.enqueueDiscoveredLinks(queue, discoveredFromAjax, 1);
                    ajaxExpansionDone = true;
                    if (!queue.length) {
                        break;
                    }
                }

                this.ensureNotStopped();
                const current = queue.shift();
                const currentUrl = normalizeUrl(current.url);

                if (this.visited.has(currentUrl)) continue;
                if (current.depth > this.options.maxDepth) continue;
                if (shouldSkipLinkForCrawl(currentUrl)) {
                    const skipReason = getSkipReasonForCrawl(currentUrl) || 'unknown';
                    this.onProgress({
                        level: 'warn',
                        message: `Ignor URL invalid (${skipReason}): ${currentUrl}`,
                    });
                    continue;
                }
                if (!robots.canFetch(currentUrl)) {
                    this.onProgress({ level: 'warn', message: `Blocat de robots.txt: ${currentUrl}` });
                    continue;
                }

                this.visited.add(currentUrl);
                this.onProgress({ level: 'info', message: `Vizitez ${this.visited.size}/${this.options.maxPages}: ${currentUrl}` });

                if (isLikelyDownloadUrl(currentUrl) || isLikelyAjaxDataUrl(currentUrl)) {
                    await this.downloadAssetDirect(currentUrl);
                    this.onProgress({ level: 'info', message: `URL de asset/ajax tratat direct: ${currentUrl}` });

                    this.ensureNotStopped();
                    const jitter = rand(this.options.delayMinMs, this.options.delayMaxMs);
                    await sleep(Math.max(jitter, robots.crawlDelayMs || 0));
                    continue;
                }

                const page = await this.context.newPage();
                const responseAssets = new Map();

                page.on('response', async (response) => {
                    try {
                        const url = response.url();
                        if (!url.startsWith('http')) return;

                        const mismatch = detectMimeMismatch(url, response.headers()['content-type'] || '');
                        if (mismatch) {
                            this.addAuditEntry('mimeMismatches', `${url}|${mismatch.contentType}`, {
                                pageUrl: currentUrl,
                                ...mismatch,
                            });
                        }

                        const sameHost = isSameHost(startUrl, url);
                        if (!sameHost && !this.options.saveExternalAssets) return;

                        if (response.request().resourceType() === 'document') return;
                        if (response.status() >= 400) return;

                        const body = await response.body();
                        if (!body || body.length === 0) return;

                        const localPath = this.localAssetPath(url, response);
                        await fs.mkdir(path.dirname(localPath), { recursive: true });
                        if (!fss.existsSync(localPath)) {
                            await fs.writeFile(localPath, body);
                        }
                        responseAssets.set(url, localPath);
                    } catch {
                        // Keep crawling even if some assets fail.
                    }
                });

                try {
                    this.ensureNotStopped();
                    try {
                        await page.goto(currentUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: this.options.pageTimeoutMs,
                        });
                    } catch (error) {
                        if (isDownloadStartingError(error) || isLikelyDownloadUrl(currentUrl) || isLikelyAjaxDataUrl(currentUrl)) {
                            await this.downloadAssetDirect(currentUrl);
                            this.onProgress({ level: 'info', message: `Endpoint download detectat, salvez direct: ${currentUrl}` });
                            continue;
                        }
                        throw error;
                    }

                    const finalUrl = normalizeUrl(page.url());
                    if (finalUrl !== currentUrl) {
                        this.addAuditEntry('redirects', `${currentUrl}=>${finalUrl}`, {
                            from: currentUrl,
                            to: finalUrl,
                        });
                    }

                    this.ensureNotStopped();
                    await page.waitForTimeout(this.options.settleMs);
                    this.ensureNotStopped();
                    await this.autoScroll(page);

                    const html = await page.content();
                    await this.downloadDomAssets(html, currentUrl, startUrl);
                    const htmlPath = path.join(this.options.outputDir, 'html', htmlFileNameFor(currentUrl));
                    this.pageMap.set(currentUrl, htmlPath);

                    const rewritten = this.rewriteHtml(html, currentUrl, htmlPath, responseAssets, startUrl);
                    await fs.writeFile(htmlPath, rewritten, 'utf8');

                    if (!this.options.singlePage) {
                        const links = this.extractLinks(html, currentUrl, startUrl);
                        this.enqueueDiscoveredLinks(queue, links, current.depth + 1);

                        // Expand and enqueue links discovered inside AJAX payloads while the crawl
                        // is still active, so pages revealed by "load more" are captured as HTML.
                        const discoveredFromAjax = await this.processAjaxPayloadAssets(startUrl);
                        this.enqueueDiscoveredLinks(queue, discoveredFromAjax, current.depth + 1);
                    }
                } catch (error) {
                    this.failed.push({ url: currentUrl, error: error.message });
                    this.onProgress({ level: 'error', message: `Eroare ${currentUrl}: ${error.message}` });
                } finally {
                    await page.close();
                }

                this.ensureNotStopped();
                const jitter = rand(this.options.delayMinMs, this.options.delayMaxMs);
                await sleep(Math.max(jitter, robots.crawlDelayMs || 0));

                if (this.options.singlePage) {
                    break;
                }
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

        // Keep offline load-more chains functional for already captured AJAX payloads.
        await this.processAjaxPayloadAssets(startUrl);
        await this.downloadAssetsReferencedBySavedCss(startUrl);
        await this.rewriteSavedCssAssets(startUrl);
        await this.writeOfflineAjaxMap();

        const htmlFolder = path.join(this.options.outputDir, 'html');
        const startPagePath = this.pageMap.get(startUrl);
        const startPageFile = startPagePath
            ? path.relative(htmlFolder, startPagePath).split(path.sep).join('/')
            : null;
        const archiveIndexFile = await this.writeIndex(startUrl);
        await this.applyOfflineCompatibilityPatches();
        const audit = await this.buildAuditReport(startUrl);

        return {
            outputDir: this.options.outputDir,
            totalVisited: this.visited.size,
            totalFailed: this.failed.length,
            failed: this.failed,
            startPageFile,
            archiveIndexFile,
            audit,
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
            message: `Pornesc autentificarea in sesiune: ${loginUrl}`,
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

            // Some login forms redirect immediately, while others authenticate via XHR.
            await loginPage.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => { });
            if (waitAfterLoginMs > 0) {
                await loginPage.waitForTimeout(waitAfterLoginMs);
            }

            if (successUrlContains && !String(loginPage.url() || '').includes(successUrlContains)) {
                throw new Error(`Login aparent finalizat, dar URL-ul nu contine "${successUrlContains}".`);
            }

            this.onProgress({
                level: 'info',
                message: 'Autentificare realizata. Pornesc crawl-ul in sesiune autentificata.',
            });
        } catch (error) {
            const wrapped = new Error(`Autentificare esuata: ${error.message}`);
            wrapped.code = 'AUTH_FAILED';
            throw wrapped;
        } finally {
            await loginPage.close().catch(() => { });
        }
    }

    async prepareDirs(out) {
        const folders = ['html', 'css', 'js', 'images', 'fonts', 'files', 'videos', 'audio'];
        await Promise.all(folders.map((name) => fs.mkdir(path.join(out, name), { recursive: true })));
    }

    localAssetPath(assetUrl, response) {
        if (this.assetMap.has(assetUrl)) {
            return this.assetMap.get(assetUrl);
        }

        const proposed = resolveOutputAssetPath(this.options.outputDir, assetUrl, response);
        const finalPath = this.ensureUnique(proposed, assetUrl);
        this.assetMap.set(assetUrl, finalPath);
        this.assetSourceByLocalPath.set(finalPath, assetUrl);
        return finalPath;
    }

    ensureUnique(filePath, seed) {
        if (!fss.existsSync(filePath)) return filePath;
        const parsed = path.parse(filePath);
        const tail = crypto.createHash('md5').update(seed).digest('hex').slice(0, 7);
        return path.join(parsed.dir, `${parsed.name}-${tail}${parsed.ext}`);
    }

    collectCssUrlTokens(cssText) {
        const tokens = [];
        const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match;
        while ((match = regex.exec(cssText)) !== null) {
            const raw = String(match[2] || '').trim();
            if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) continue;
            tokens.push(raw);
        }
        return tokens;
    }

    resolveCssTokenUrl(cssAssetUrl, rawToken) {
        try {
            return normalizeUrl(new URL(rawToken, cssAssetUrl).toString());
        } catch {
            return null;
        }
    }

    isCssAssetEntry(assetUrl, localPath) {
        const localDir = path.basename(path.dirname(localPath)).toLowerCase();
        if (localDir === 'css') return true;
        try {
            return path.extname(new URL(assetUrl).pathname || '').toLowerCase() === '.css';
        } catch {
            return String(localPath).toLowerCase().includes('.css');
        }
    }

    isAjaxAssetEntry(assetUrl, localPath) {
        if (isLikelyAjaxDataUrl(assetUrl)) return true;
        return path.extname(localPath).toLowerCase() === '.json';
    }

    localJsonLinkForHtmlPages(localPath) {
        return `../files/${path.basename(localPath)}`;
    }

    linkFromHtmlFolder(localPath) {
        const htmlFolder = path.join(this.options.outputDir, 'html');
        return path.relative(htmlFolder, localPath).split(path.sep).join('/');
    }

    resolveKnownSavedPageUrl(absoluteUrl, startUrl) {
        const normalized = normalizeUrl(absoluteUrl);
        if (this.pageMap.has(normalized)) return normalized;

        let parsed;
        try {
            parsed = new URL(normalized);
        } catch {
            return null;
        }
        if (!isSameHost(startUrl, parsed.toString())) return null;

        const pathname = parsed.pathname || '/';
        const candidatePaths = [];

        if (!pathname.startsWith('/ro/')) {
            candidatePaths.push(`/ro${pathname === '/' ? '' : pathname}`);
        } else {
            candidatePaths.push(pathname.replace(/^\/ro\//, '/'));
        }

        for (const candidatePath of candidatePaths) {
            try {
                const candidateUrl = normalizeUrl(new URL(`${candidatePath}${parsed.search || ''}`, parsed.origin).toString());
                if (this.pageMap.has(candidateUrl)) {
                    return candidateUrl;
                }
            } catch {
                // Ignore invalid candidate transformations.
            }
        }

        return null;
    }

    isLikelyLocalExportRef(rawValue) {
        const raw = String(rawValue || '').trim();
        if (!raw) return false;

        // Keep absolute web links eligible for rewriting.
        if (/^(?:https?:)?\/\//i.test(raw)) return false;
        // Leading slash usually means an origin-root website URL, not a local exported file.
        if (raw.startsWith('/')) return false;

        return /(?:^|\/)[^/?#]+\.(?:html?|css|js|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|mp4|mp3|json)(?:[?#].*)?$/i.test(raw);
    }

    normalizeInternalPageUrl(raw, currentUrl, startUrl) {
        const value = String(raw || '').trim();
        if (!value || /^(#|data:|mailto:|tel:|javascript:)/i.test(value)) return null;

        let absolute;
        try {
            absolute = normalizeUrl(new URL(value, currentUrl).toString());
        } catch {
            return null;
        }

        if (!isSameHost(startUrl, absolute)) return null;
        if (shouldSkipLinkForCrawl(absolute)) return null;
        if (looksLikeAssetUrl(absolute)) return null;
        if (isLikelyDownloadUrl(absolute)) return null;
        if (isLikelyAjaxDataUrl(absolute)) return null;
        return absolute;
    }

    collectLinksFromAjaxPayloadValue(value, ajaxUrl, startUrl, links) {
        if (typeof value === 'string') {
            const raw = value.trim();
            if (!raw) return;

            if (/<a\b[^>]*href\s*=|<a\b/i.test(raw)) {
                const extracted = this.extractLinks(raw, ajaxUrl, startUrl);
                for (const link of extracted) {
                    links.add(link);
                }
                return;
            }

            const maybeLink = this.normalizeInternalPageUrl(raw, ajaxUrl, startUrl);
            if (maybeLink) {
                links.add(maybeLink);
            }
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                this.collectLinksFromAjaxPayloadValue(item, ajaxUrl, startUrl, links);
            }
            return;
        }

        if (value && typeof value === 'object') {
            for (const nested of Object.values(value)) {
                this.collectLinksFromAjaxPayloadValue(nested, ajaxUrl, startUrl, links);
            }
        }
    }

    rewriteAjaxHtmlFragment(fragmentHtml, ajaxUrl, startUrl) {
        if (typeof fragmentHtml !== 'string' || !fragmentHtml.trim()) return fragmentHtml;
        const $ = cheerio.load(fragmentHtml);

        const rewrite = (selector, attr) => {
            $(selector).each((_, el) => {
                const raw = ($(el).attr(attr) || '').trim();
                if (!raw || /^(#|data:|mailto:|tel:|javascript:)/i.test(raw)) return;

                if (this.isLikelyLocalExportRef(raw)) return;

                // Avoid double-rewriting links that already target local exported files.
                if (/^(?:\.\.\/|\.\/|\/)?(?:en-)?article-[^/?#]+\.html(?:[?#].*)?$/i.test(raw)) return;
                if (/^(?:\.\.\/|\.\/).*\.(?:html|css|js|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|mp4|mp3|json)(?:[?#].*)?$/i.test(raw)) return;

                let absolute;
                try {
                    absolute = normalizeUrl(new URL(raw, ajaxUrl).toString());
                } catch {
                    return;
                }

                const resolvedPageUrl = this.resolveKnownSavedPageUrl(absolute, startUrl);
                if (resolvedPageUrl && this.pageMap.has(resolvedPageUrl)) {
                    $(el).attr(attr, this.linkFromHtmlFolder(this.pageMap.get(resolvedPageUrl)));
                    return;
                }

                if (this.pageMap.has(absolute)) {
                    $(el).attr(attr, this.linkFromHtmlFolder(this.pageMap.get(absolute)));
                    return;
                }

                if (this.assetMap.has(absolute)) {
                    $(el).attr(attr, this.linkFromHtmlFolder(this.assetMap.get(absolute)));
                    return;
                }

                if (!isSameHost(startUrl, absolute)) {
                    return;
                }

                if (shouldSkipLinkForCrawl(absolute)) {
                    return;
                }

                if (looksLikeAssetUrl(absolute) || isLikelyDownloadUrl(absolute) || isLikelyAjaxDataUrl(absolute)) {
                    return;
                }

                $(el).attr(attr, htmlFileNameFor(absolute));
            });
        };

        rewrite('a[href]', 'href');
        rewrite('img[src]', 'src');
        rewrite('source[src]', 'src');
        rewrite('video[src]', 'src');
        rewrite('audio[src]', 'src');

        return $('body').html() || $.root().html() || fragmentHtml;
    }

    rewriteAjaxPayloadValue(value, ajaxUrl, startUrl) {
        if (typeof value === 'string') {
            const raw = value.trim();
            if (!raw) return value;

            if (/<a\b[^>]*href\s*=|<img\b|<source\b|<video\b|<audio\b|<div\b|<section\b/i.test(raw)) {
                return this.rewriteAjaxHtmlFragment(value, ajaxUrl, startUrl);
            }

            return value;
        }

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i += 1) {
                value[i] = this.rewriteAjaxPayloadValue(value[i], ajaxUrl, startUrl);
            }
            return value;
        }

        if (value && typeof value === 'object') {
            for (const key of Object.keys(value)) {
                value[key] = this.rewriteAjaxPayloadValue(value[key], ajaxUrl, startUrl);
            }
            return value;
        }

        return value;
    }

    async processAjaxPayloadAssets(startUrl) {
        const pending = [];
        const queued = new Set();
        const discoveredLinks = new Set();

        for (const [assetUrl, localPath] of this.assetMap.entries()) {
            if (!this.isAjaxAssetEntry(assetUrl, localPath)) continue;
            pending.push(assetUrl);
            queued.add(assetUrl);
        }

        // Expand AJAX pagination chains (load_more_url) so repeated clicks keep working.
        while (pending.length) {
            this.ensureNotStopped();
            const ajaxUrl = pending.shift();
            const localPath = this.assetMap.get(ajaxUrl);
            if (!localPath) continue;

            const raw = await fs.readFile(localPath, 'utf8').catch(() => '');
            if (!raw) continue;

            let payload;
            try {
                payload = JSON.parse(raw);
            } catch {
                continue;
            }

            this.collectLinksFromAjaxPayloadValue(payload, ajaxUrl, startUrl, discoveredLinks);

            const nextRaw = String(payload?.load_more_url || '').trim();
            if (!nextRaw) continue;

            let nextAbsolute;
            try {
                nextAbsolute = normalizeUrl(new URL(nextRaw, ajaxUrl).toString());
            } catch {
                continue;
            }

            if (!isSameHost(startUrl, nextAbsolute)) continue;
            if (!isLikelyAjaxDataUrl(nextAbsolute)) continue;

            await this.downloadAssetDirect(nextAbsolute);
            if (!queued.has(nextAbsolute)) {
                queued.add(nextAbsolute);
                pending.push(nextAbsolute);
            }
        }

        // Rewrite load_more_url values to local JSON files.
        const ajaxEntries = [...this.assetMap.entries()]
            .filter(([assetUrl, localPath]) => this.isAjaxAssetEntry(assetUrl, localPath));

        for (const [ajaxUrl, localPath] of ajaxEntries) {
            this.ensureNotStopped();
            const raw = await fs.readFile(localPath, 'utf8').catch(() => '');
            if (!raw) continue;

            let payload;
            try {
                payload = JSON.parse(raw);
            } catch {
                continue;
            }

            const nextRaw = String(payload?.load_more_url || '').trim();
            if (nextRaw) {
                let nextAbsolute;
                try {
                    nextAbsolute = normalizeUrl(new URL(nextRaw, ajaxUrl).toString());
                } catch {
                    nextAbsolute = null;
                }

                if (nextAbsolute && this.assetMap.has(nextAbsolute)) {
                    const nextLocalPath = this.assetMap.get(nextAbsolute);
                    payload.load_more_url = this.localJsonLinkForHtmlPages(nextLocalPath);
                }
            }

            payload = this.rewriteAjaxPayloadValue(payload, ajaxUrl, startUrl);
            await fs.writeFile(localPath, JSON.stringify(payload), 'utf8');
        }

        return [...discoveredLinks];
    }

    async downloadAssetsReferencedBySavedCss(startUrl) {
        const cssEntries = [...this.assetMap.entries()]
            .filter(([assetUrl, localPath]) => this.isCssAssetEntry(assetUrl, localPath));

        const discovered = new Set();
        for (const [cssAssetUrl, cssLocalPath] of cssEntries) {
            const css = await fs.readFile(cssLocalPath, 'utf8').catch(() => '');
            if (!css) continue;

            for (const token of this.collectCssUrlTokens(css)) {
                const absolute = this.resolveCssTokenUrl(cssAssetUrl, token);
                if (!absolute || !absolute.startsWith('http')) continue;
                if (!isSameHost(startUrl, absolute) && !this.options.saveExternalAssets) continue;
                if (!looksLikeAssetUrl(absolute) && !isLikelyDownloadUrl(absolute)) continue;
                discovered.add(absolute);
            }
        }

        for (const assetUrl of discovered) {
            this.ensureNotStopped();
            await this.downloadAssetDirect(assetUrl);
        }
    }

    async rewriteSavedCssAssets(startUrl) {
        const cssEntries = [...this.assetMap.entries()]
            .filter(([assetUrl, localPath]) => this.isCssAssetEntry(assetUrl, localPath));

        for (const [cssAssetUrl, cssLocalPath] of cssEntries) {
            this.ensureNotStopped();
            const css = await fs.readFile(cssLocalPath, 'utf8').catch(() => '');
            if (!css) continue;

            const rewritten = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, rawValue) => {
                const raw = String(rawValue || '').trim();
                if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) return full;

                const absolute = this.resolveCssTokenUrl(cssAssetUrl, raw);
                if (!absolute) return full;

                if (this.assetMap.has(absolute)) {
                    const localTarget = this.assetMap.get(absolute);
                    const rel = safeRelativeLink(cssLocalPath, localTarget);
                    return `url("${rel}")`;
                }

                if (isSameHost(startUrl, absolute)) {
                    // Keep unresolved same-host CSS assets absolute to preserve rendering.
                    return `url("${absolute}")`;
                }

                return full;
            });

            if (rewritten !== css) {
                await fs.writeFile(cssLocalPath, rewritten, 'utf8');
            }
        }
    }

    rewriteHtml(html, currentUrl, currentHtmlPath, responseAssets, startUrl) {
        const $ = cheerio.load(html);

        const rewrite = (selector, attr) => {
            $(selector).each((_, el) => {
                const raw = $(el).attr(attr);
                if (!raw) return;
                if (/^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) return;

                if (this.isLikelyLocalExportRef(raw)) return;

                let absolute;
                try {
                    absolute = normalizeUrl(new URL(raw, currentUrl).toString());
                } catch {
                    return;
                }

                const resolvedPageUrl = this.resolveKnownSavedPageUrl(absolute, startUrl);
                if (resolvedPageUrl && this.pageMap.has(resolvedPageUrl)) {
                    $(el).attr(attr, safeRelativeLink(currentHtmlPath, this.pageMap.get(resolvedPageUrl)));
                    return;
                }

                if (this.pageMap.has(absolute)) {
                    $(el).attr(attr, safeRelativeLink(currentHtmlPath, this.pageMap.get(absolute)));
                    return;
                }

                if (responseAssets.has(absolute)) {
                    $(el).attr(attr, safeRelativeLink(currentHtmlPath, responseAssets.get(absolute)));
                    return;
                }

                if (this.assetMap.has(absolute)) {
                    $(el).attr(attr, safeRelativeLink(currentHtmlPath, this.assetMap.get(absolute)));
                    return;
                }

                if (isSameHost(startUrl, absolute)) {
                    if (shouldSkipLinkForCrawl(absolute)) {
                        // Keep unresolved template placeholders as original value.
                        return;
                    }
                    if (looksLikeAssetUrl(absolute) || isLikelyDownloadUrl(absolute) || isLikelyAjaxDataUrl(absolute)) {
                        // If not captured/downloaded, keep absolute URL instead of creating a fake .html page path.
                        $(el).attr(attr, absolute);
                        return;
                    }
                    $(el).attr(attr, htmlFileNameFor(absolute));
                }
            });
        };

        rewrite('a[href]', 'href');
        rewrite('link[href]', 'href');
        rewrite('script[src]', 'src');
        rewrite('img[src]', 'src');
        rewrite('source[src]', 'src');
        rewrite('video[src]', 'src');
        rewrite('audio[src]', 'src');

        // file:// pages have origin "null" and strict CORS rules for module/crossorigin scripts.
        // For archive-local assets, keep script loading in classic mode to preserve offline behavior.
        $('script[src], link[href]').each((_, el) => {
            const tag = String(el.tagName || '').toLowerCase();
            const attr = tag === 'script' ? 'src' : 'href';
            const ref = String($(el).attr(attr) || '').trim();
            if (!ref) return;

            const isLocalArchiveRef = ref.startsWith('../') || ref.startsWith('./') || ref.startsWith('..\\') || ref.startsWith('.\\');
            if (!isLocalArchiveRef) return;

            $(el).removeAttr('crossorigin');
            $(el).removeAttr('integrity');
            $(el).removeAttr('referrerpolicy');

            if (tag === 'script' && String($(el).attr('type') || '').toLowerCase() === 'module') {
                $(el).removeAttr('type');
            }
        });

        // Enable offline JSON-backed AJAX flows (load-more, category filters, etc.) on file://.
        if ($('#copilot-offline-ajax-bootstrap').length === 0) {
            if ($('head').length > 0) {
                $('head').prepend(this.offlineAjaxBootstrapHtml());
            } else {
                $('body').append(this.offlineAjaxBootstrapHtml());
            }
        }

        return $.html();
    }

    async writeOfflineAjaxMap() {
        const filesDir = path.join(this.options.outputDir, 'files');
        const map = {};

        const entries = await fs.readdir(filesDir).catch(() => []);
        for (const fileName of entries) {
            if (!fileName.toLowerCase().endsWith('.json')) continue;

            const filePath = path.join(filesDir, fileName);
            const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
            if (!raw) continue;

            try {
                const parsed = JSON.parse(raw);
                map[`/files/${fileName}`] = parsed;
            } catch {
                // Keep map generation resilient when some JSON files are malformed.
            }
        }

        const outFile = path.join(filesDir, 'offline-ajax-map.js');
        const content = `window.__OFFLINE_AJAX_MAP__ = ${JSON.stringify(map)};\n`;
        await fs.writeFile(outFile, content, 'utf8');
    }

    offlineAjaxBootstrapHtml() {
        return [
            '<script id="copilot-offline-ajax-bootstrap">',
            '(function(){',
            'var protocol=String(location.protocol||"").toLowerCase();',
            'var host=String(location.hostname||"").toLowerCase();',
            'var isLocalHttp=(protocol==="http:"||protocol==="https:")&&(host==="localhost"||host==="127.0.0.1");',
            'if(protocol!=="file:"&&!isLocalHttp)return;',
            'var w=window;',
            'function bindOfflineDropdownFallback(){',
            'if(protocol!=="file:")return;',
            'if(w.bootstrap&&typeof w.bootstrap.Dropdown==="function")return;',
            'function closeAll(){',
            'var opened=document.querySelectorAll(".dropdown-menu.show");',
            'opened.forEach(function(menu){',
            'menu.classList.remove("show");',
            'var parent=menu.closest(".dropdown,.nav-item");',
            'if(parent)parent.classList.remove("show");',
            '});',
            'var expanded=document.querySelectorAll("[data-toggle=\\\"dropdown\\\"],[data-bs-toggle=\\\"dropdown\\\"]");',
            'expanded.forEach(function(toggle){toggle.setAttribute("aria-expanded","false");});',
            '}',
            'document.addEventListener("click",function(evt){',
            'var toggle=evt.target&&evt.target.closest?evt.target.closest("[data-toggle=\\\"dropdown\\\"],[data-bs-toggle=\\\"dropdown\\\"]"):null;',
            'if(!toggle){closeAll();return;}',
            'evt.preventDefault();',
            'evt.stopPropagation();',
            'var parent=toggle.closest(".dropdown,.nav-item")||toggle.parentElement;',
            'if(!parent)return;',
            'var menu=parent.querySelector(".dropdown-menu");',
            'if(!menu)return;',
            'var willOpen=!menu.classList.contains("show");',
            'closeAll();',
            'if(willOpen){',
            'menu.classList.add("show");',
            'parent.classList.add("show");',
            'toggle.setAttribute("aria-expanded","true");',
            '}',
            '},true);',
            '}',
            'bindOfflineDropdownFallback();',
            'function keyFromPath(pathValue){',
            'var path=String(pathValue||"").replace(/\\\\/g,"/");',
            'path=path.split("?")[0].split("#")[0];',
            'var lower=path.toLowerCase();',
            'var marker="/files/";',
            'var idx=lower.lastIndexOf(marker);',
            'if(idx===-1)return"";',
            'var rest=path.slice(idx+marker.length);',
            'if(!rest)return"";',
            'var fileName=rest.split("/")[0];',
            'if(!fileName)return"";',
            'return"/files/"+fileName;',
            '}',
            'function keyFromUrl(input){',
            'var str=String(input||"").trim();',
            'if(!str)return"";',
            'var fromRaw=keyFromPath(str);',
            'if(fromRaw)return fromRaw;',
            'try{',
            'var u=new URL(str,location.href);',
            'var fromAbs=keyFromPath(u.pathname||"");',
            'if(fromAbs)return fromAbs;',
            '}catch(e){}',
            'return"";',
            '}',
            'function payloadFor(input){',
            'var key=keyFromUrl(input);',
            'if(!key)return null;',
            'var map=w.__OFFLINE_AJAX_MAP__||{};',
            'return Object.prototype.hasOwnProperty.call(map,key)?map[key]:null;',
            '}',
            'function clonePayload(payload){',
            'if(payload===null||payload===undefined)return payload;',
            'return JSON.parse(JSON.stringify(payload));',
            '}',
            // The AJAX payload map can be hundreds of KB for large sites, so it is loaded via
            // a dynamically-injected script (non-blocking) instead of a blocking <script src>.
            // The click listener below registers synchronously and awaits mapReady before
            // acting, so a click landing before the map finishes loading is still caught
            // instead of falling through to a real page navigation.
            'var mapReady=new Promise(function(resolve){',
            'var s=document.createElement("script");',
            's.src="../files/offline-ajax-map.js";',
            's.onload=function(){resolve();};',
            's.onerror=function(){resolve();};',
            'document.head.appendChild(s);',
            '});',
            'if(typeof w.fetch==="function"){',
            'var nativeFetch=w.fetch.bind(w);',
            'w.fetch=function(input,init){',
            'var reqUrl=(typeof input==="string"?input:(input&&input.url)||"");',
            'var payload=payloadFor(reqUrl);',
            'if(payload===null)return nativeFetch(input,init);',
            'var body=JSON.stringify(payload);',
            'if(typeof Response!=="undefined"){',
            'return Promise.resolve(new Response(body,{status:200,headers:{"Content-Type":"application/json"}}));',
            '}',
            'return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(clonePayload(payload));},text:function(){return Promise.resolve(body);}});',
            '};',
            '}',
            'if(w.XMLHttpRequest&&w.XMLHttpRequest.prototype){',
            'var nativeOpen=w.XMLHttpRequest.prototype.open;',
            'var nativeSend=w.XMLHttpRequest.prototype.send;',
            'var nativeSetHeader=w.XMLHttpRequest.prototype.setRequestHeader;',
            'w.XMLHttpRequest.prototype.open=function(method,url,async,user,password){',
            'var payload=payloadFor(url);',
            'if(payload!==null){',
            'this.__offlinePayload=payload;',
            'this.__offlineUrl=String(url||"");',
            'this.readyState=1;',
            'return;',
            '}',
            'this.__offlinePayload=undefined;',
            'return nativeOpen.call(this,method,url,async,user,password);',
            '};',
            'w.XMLHttpRequest.prototype.setRequestHeader=function(name,value){',
            'if(this.__offlinePayload!==undefined)return;',
            'return nativeSetHeader.call(this,name,value);',
            '};',
            'w.XMLHttpRequest.prototype.send=function(body){',
            'if(this.__offlinePayload===undefined){',
            'return nativeSend.call(this,body);',
            '}',
            'var self=this;',
            'var text=JSON.stringify(self.__offlinePayload);',
            'setTimeout(function(){',
            'self.status=200;',
            'self.statusText="OK";',
            'self.responseURL=self.__offlineUrl||"";',
            'self.responseText=text;',
            'self.response=text;',
            'self.readyState=4;',
            'self.getResponseHeader=function(name){',
            'if(!name)return null;',
            'return String(name).toLowerCase()==="content-type"?"application/json":null;',
            '};',
            'self.getAllResponseHeaders=function(){',
            'return "content-type: application/json\\r\\n";',
            '};',
            'if(typeof self.onreadystatechange==="function")self.onreadystatechange();',
            'if(typeof self.onload==="function")self.onload();',
            '},0);',
            '};',
            '}',
            'var $=w.jQuery;',
            'if($&&typeof $.ajax==="function"){',
            'var originalAjax=$.ajax.bind($);',
            '$.ajax=function(urlOrOptions,maybeOptions){',
            'var options={};',
            'var requestUrl="";',
            'if(typeof urlOrOptions==="string"){requestUrl=urlOrOptions;options=maybeOptions||{};}else{options=urlOrOptions||{};requestUrl=options.url||"";}',
            'var payload=payloadFor(requestUrl);',
            'if(payload===null)return originalAjax(urlOrOptions,maybeOptions);',
            'var data=clonePayload(payload);',
            'setTimeout(function(){',
            'if(typeof options.success==="function")options.success(data,"success",null);',
            'if(typeof options.complete==="function")options.complete(null,"success");',
            '},0);',
            'if(typeof $.Deferred==="function"){',
            'var d=$.Deferred();',
            'd.resolve(data,"success",null);',
            'return d.promise();',
            '}',
            'return Promise.resolve(data);',
            '};',
            '}',
            'function renderLoadMoreFallback(anchor,payload){',
            'if(!payload||typeof payload!=="object")return;',
            'if(typeof payload.html==="string"&&payload.html){',
            'var scope=anchor&&anchor.closest?anchor.closest(".search_content_container,.widget-container,.container,.container-fluid"):null;',
            'var container=(scope&&scope.querySelector(".articles-list-data-container-js"))',
            '||document.querySelector(".articles-list-data-container-js")',
            '||document.querySelector(".gallery-page .gallery-items.grid")',
            '||document.querySelector(".gallery-list-widget.grid")',
            '||document.querySelector(".grid");',
            'if(container)container.insertAdjacentHTML("beforeend",payload.html);',
            '}',
            'var nextUrl=(typeof payload.load_more_url==="string")?payload.load_more_url:"";',
            'anchor.setAttribute("href",nextUrl);',
            'if(!nextUrl){anchor.classList.add("hide-load-more");}else{anchor.classList.remove("hide-load-more");}',
            'anchor.classList.remove("disabled");',
            '}',
            // Capture phase + stopImmediatePropagation gives us sole ownership of these
            // anchors: we never rely on the page's own (possibly broken/unbound) click
            // handler to also call preventDefault, which was the source of intermittent
            // "click falls through to a real navigation" failures.
            'document.addEventListener("click",function(evt){',
            'var target=evt.target;',
            'if(!target||typeof target.closest!=="function")return;',
            'var anchor=target.closest("a#load-more-gallery-items,a#load-more-galleries,a#load-more-articles,a.load-more");',
            'if(!anchor)return;',
            'evt.preventDefault();',
            'evt.stopImmediatePropagation();',
            'if(anchor.classList.contains("disabled"))return;',
            'anchor.classList.add("disabled");',
            'var href=anchor.getAttribute("href")||anchor.href||"";',
            'mapReady.then(function(){',
            'var payload=payloadFor(href);',
            'if(payload===null){',
            'anchor.classList.remove("disabled");',
            'window.location.href=href;',
            'return;',
            '}',
            'renderLoadMoreFallback(anchor,clonePayload(payload));',
            '});',
            '},true);',
            '})();',
            '</script>',
        ].join('');
    }

    extractLinks(html, currentUrl, startUrl) {
        const $ = cheerio.load(html);
        const links = new Set();

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;

            try {
                const absolute = normalizeUrl(new URL(href, currentUrl).toString());
                if (!isSameHost(startUrl, absolute)) return;
                if (shouldSkipLinkForCrawl(absolute)) return;
                if (isLikelyDownloadUrl(absolute)) return;
                if (isLikelyAjaxDataUrl(absolute)) return;
                links.add(absolute);
            } catch {
                // Ignore invalid URLs.
            }
        });

        return [...links];
    }

    collectDomAssetUrls(html, currentUrl, startUrl) {
        const $ = cheerio.load(html);
        const assets = new Set();
        const selectors = [
            ['link[href]', 'href'],
            ['script[src]', 'src'],
            ['img[src]', 'src'],
            ['source[src]', 'src'],
            ['video[src]', 'src'],
            ['audio[src]', 'src'],
            ['a[href]', 'href'],
        ];

        for (const [selector, attr] of selectors) {
            $(selector).each((_, el) => {
                const raw = ($(el).attr(attr) || '').trim();
                if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) return;

                let absolute;
                try {
                    absolute = normalizeUrl(new URL(raw, currentUrl).toString());
                } catch {
                    return;
                }

                if (!absolute.startsWith('http')) return;
                if (!looksLikeAssetUrl(absolute) && !isLikelyDownloadUrl(absolute) && !isLikelyAjaxDataUrl(absolute)) return;
                if (!isSameHost(startUrl, absolute) && !this.options.saveExternalAssets) return;
                assets.add(absolute);
            });
        }

        return [...assets];
    }

    async downloadAssetDirect(assetUrl) {
        if (this.assetMap.has(assetUrl)) return;
        try {
            const fallbackUrl = this.localizedStaticFallbackUrl(assetUrl);
            const candidates = fallbackUrl && fallbackUrl !== assetUrl
                ? [assetUrl, fallbackUrl]
                : [assetUrl];

            for (const candidate of candidates) {
                if (this.assetMap.has(candidate)) {
                    this.assetMap.set(assetUrl, this.assetMap.get(candidate));
                    return;
                }

                const ac = new AbortController();
                const timeout = setTimeout(() => ac.abort(), this.options.directAssetTimeoutMs);
                const res = await fetch(candidate, {
                    headers: {
                        'User-Agent': this.options.userAgent,
                        'Accept-Language': 'ro,en;q=0.8',
                    },
                    redirect: 'follow',
                    signal: ac.signal,
                }).catch(() => null);
                clearTimeout(timeout);

                if (!res || !res.ok) continue;

                const body = Buffer.from(await res.arrayBuffer());
                if (!body.length) continue;

                const contentType = res.headers.get('content-type') || '';
                const mismatch = detectMimeMismatch(assetUrl, contentType);
                if (mismatch) {
                    this.addAuditEntry('mimeMismatches', `${assetUrl}|${mismatch.contentType}`, {
                        pageUrl: null,
                        ...mismatch,
                    });
                }
                const contentDisposition = res.headers.get('content-disposition') || '';
                const fakeResponse = {
                    headers() {
                        return {
                            'content-type': contentType,
                            'content-disposition': contentDisposition,
                        };
                    },
                };

                const localPath = this.localAssetPath(assetUrl, fakeResponse);
                await fs.mkdir(path.dirname(localPath), { recursive: true });
                if (!fss.existsSync(localPath)) {
                    await fs.writeFile(localPath, body);
                }

                this.assetMap.set(candidate, localPath);
                return;
            }
        } catch {
            // Direct asset download failures should not stop crawl.
        }
    }

    localizedStaticFallbackUrl(assetUrl) {
        try {
            const url = new URL(assetUrl);
            const fallbackPath = url.pathname.replace(/^\/([a-z]{2})(?=\/(images|img|css|js|fonts|audio|video|files)\b)/i, '');
            if (fallbackPath === url.pathname) return null;
            url.pathname = fallbackPath;
            return normalizeUrl(url.toString());
        } catch {
            return null;
        }
    }

    async downloadDomAssets(html, currentUrl, startUrl) {
        const urls = this.collectDomAssetUrls(html, currentUrl, startUrl);
        // Keep this bounded so per-page capture stays responsive.
        const priorityFor = (urlString) => {
            if (isLikelyDownloadUrl(urlString)) return 0;
            if (isLikelyAjaxDataUrl(urlString)) return 0;
            try {
                const ext = path.extname(new URL(urlString).pathname || '').toLowerCase();
                if (['.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 1;
                if (['.woff', '.woff2', '.ttf', '.otf', '.eot', '.svg'].includes(ext)) return 2;
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) return 3;
                return 4;
            } catch {
                return 5;
            }
        };

        const prioritized = [...urls].sort((a, b) => priorityFor(a) - priorityFor(b));
        const limit = Math.min(prioritized.length, this.options.domAssetDirectLimit);
        const selected = prioritized.slice(0, limit);
        let index = 0;
        const workers = Array.from({ length: Math.max(1, this.options.domAssetDirectConcurrency) }, async () => {
            while (index < selected.length) {
                this.ensureNotStopped();
                const i = index;
                index += 1;
                await this.downloadAssetDirect(selected[i]);
            }
        });
        await Promise.all(workers);
    }

    async autoScroll(page) {
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let total = 0;
                const step = 550;
                const timer = setInterval(() => {
                    window.scrollBy(0, step);
                    total += step;
                    const fullHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                    if (total >= fullHeight) {
                        clearInterval(timer);
                        window.scrollTo(0, 0);
                        resolve();
                    }
                }, 140);
            });
        });
    }

    async writeIndex(startUrl) {
        const htmlFolder = path.join(this.options.outputDir, 'html');
        const pages = [...this.pageMap.entries()]
            .map(([url, filePath]) => ({ url, file: path.relative(htmlFolder, filePath).split(path.sep).join('/') }))
            .sort((a, b) => a.url.localeCompare(b.url));

        const html = `<!doctype html>
<html lang="ro">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Crawler Studio Export</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 28px auto; max-width: 900px; padding: 0 16px; }
    h1 { margin-bottom: 8px; }
    p { color: #444; }
    li { margin: 5px 0; }
  </style>
</head>
<body>
  <h1>Crawler Studio Export</h1>
  <p>Sursa: ${startUrl}</p>
  <p>Pagini: ${pages.length} | Erori: ${this.failed.length}</p>
  <ul>
    ${pages.map((p) => `<li><a href="${p.file}">${p.url}</a></li>`).join('\n')}
  </ul>
</body>
</html>`;

        const archiveIndexFile = 'archive-index.html';
        await fs.writeFile(path.join(htmlFolder, archiveIndexFile), html, 'utf8');
        await fs.writeFile(
            path.join(this.options.outputDir, 'run-summary.json'),
            JSON.stringify({ pages, failed: this.failed, archiveIndexFile }, null, 2),
        );
        return archiveIndexFile;
    }

    async applyOfflineCompatibilityPatches() {
        const htmlFolder = path.join(this.options.outputDir, 'html');
        const files = await fs.readdir(htmlFolder).catch(() => []);

        for (const fileName of files) {
            if (!String(fileName).toLowerCase().endsWith('.html')) continue;
            const fullPath = path.join(htmlFolder, fileName);
            const html = await fs.readFile(fullPath, 'utf8').catch(() => '');
            if (!html) continue;

            const $ = cheerio.load(html);

            $('script[src], link[href]').each((_, el) => {
                const tag = String(el.tagName || '').toLowerCase();
                const attr = tag === 'script' ? 'src' : 'href';
                const ref = String($(el).attr(attr) || '').trim();
                if (!ref) return;

                const isLocalArchiveRef = ref.startsWith('../') || ref.startsWith('./') || ref.startsWith('..\\') || ref.startsWith('.\\');
                if (!isLocalArchiveRef) return;

                $(el).removeAttr('crossorigin');
                $(el).removeAttr('integrity');
                $(el).removeAttr('referrerpolicy');

                if (tag === 'script' && String($(el).attr('type') || '').toLowerCase() === 'module') {
                    $(el).removeAttr('type');
                }
            });

            if ($('#copilot-offline-ajax-bootstrap').length === 0) {
                if ($('head').length > 0) {
                    $('head').prepend(this.offlineAjaxBootstrapHtml());
                } else {
                    $('body').append(this.offlineAjaxBootstrapHtml());
                }
            }

            await fs.writeFile(fullPath, $.html(), 'utf8');
        }
    }

    async buildAuditReport(startUrl) {
        const outputRoot = path.resolve(this.options.outputDir);
        const assetSelectors = [
            ['link[href]', 'href'],
            ['script[src]', 'src'],
            ['img[src]', 'src'],
            ['source[src]', 'src'],
            ['video[src]', 'src'],
            ['audio[src]', 'src'],
        ];

        const resolveLocalRef = (pageDir, rawValue) => {
            const clean = String(rawValue || '').split('#')[0].split('?')[0].trim();
            if (!clean) return null;

            const resolved = clean.startsWith('/')
                ? path.resolve(outputRoot, clean.slice(1))
                : path.resolve(pageDir, clean);

            const isInside = resolved === outputRoot || resolved.startsWith(`${outputRoot}${path.sep}`);
            if (!isInside) return null;
            return { clean, resolved };
        };

        for (const [pageUrl, pageFilePath] of this.pageMap.entries()) {
            const html = await fs.readFile(pageFilePath, 'utf8').catch(() => '');
            if (!html) continue;

            const $ = cheerio.load(html);
            const pageDir = path.dirname(pageFilePath);

            for (const [selector, attr] of assetSelectors) {
                const nodes = $(selector).toArray();
                for (const el of nodes) {
                    const raw = ($(el).attr(attr) || '').trim();
                    if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) continue;

                    if (/^https?:\/\//i.test(raw)) {
                        let absolute;
                        try {
                            absolute = normalizeUrl(raw);
                        } catch {
                            continue;
                        }

                        if (!isSameHost(startUrl, absolute)) continue;
                        if (!looksLikeAssetUrl(absolute) && !isLikelyDownloadUrl(absolute) && !isLikelyAjaxDataUrl(absolute)) continue;
                        this.addAuditEntry('missingAssets', `${pageUrl}|${absolute}`, {
                            pageUrl,
                            assetUrl: absolute,
                            source: `${selector}[${attr}]`,
                            reason: 'asset same-host ramas remote in HTML',
                        });
                        continue;
                    }

                    const localRef = resolveLocalRef(pageDir, raw);
                    if (!localRef) continue;
                    const stat = await fs.stat(localRef.resolved).catch(() => null);
                    if (stat && stat.isFile()) continue;

                    this.addAuditEntry('missingAssets', `${pageUrl}|${localRef.clean}`, {
                        pageUrl,
                        assetUrl: localRef.clean,
                        source: `${selector}[${attr}]`,
                        reason: 'fisier local lipsa dupa rewrite',
                    });
                }
            }

            const linkNodes = $('a[href]').toArray();
            for (const el of linkNodes) {
                const raw = ($(el).attr('href') || '').trim();
                if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) continue;

                if (/^https?:\/\//i.test(raw)) {
                    let absolute;
                    try {
                        absolute = normalizeUrl(raw);
                    } catch {
                        continue;
                    }

                    if (shouldSkipLinkForCrawl(absolute)) continue;

                    if (!isSameHost(startUrl, absolute)) continue;

                    if (looksLikeAssetUrl(absolute) || isLikelyDownloadUrl(absolute)) {
                        this.addAuditEntry('missingAssets', `${pageUrl}|${absolute}`, {
                            pageUrl,
                            assetUrl: absolute,
                            source: 'a[href]',
                            reason: 'link spre asset same-host ramas remote',
                        });
                    } else if (!this.pageMap.has(absolute)) {
                        this.addAuditEntry('brokenInternalLinks', `${pageUrl}|${absolute}`, {
                            pageUrl,
                            targetUrl: absolute,
                            reason: 'pagina interna neexportata',
                        });
                    }
                    continue;
                }

                const localRef = resolveLocalRef(pageDir, raw);
                if (!localRef) continue;
                const maybeAbsolute = (() => {
                    try {
                        return normalizeUrl(new URL(raw, pageUrl).toString());
                    } catch {
                        return null;
                    }
                })();
                if (maybeAbsolute && shouldSkipLinkForCrawl(maybeAbsolute)) continue;
                const stat = await fs.stat(localRef.resolved).catch(() => null);
                if (stat && stat.isFile()) continue;

                this.addAuditEntry('brokenInternalLinks', `${pageUrl}|${localRef.clean}`, {
                    pageUrl,
                    targetUrl: localRef.clean,
                    reason: 'fisier local lipsa dupa rewrite',
                });
            }
        }

        const report = {
            generatedAt: new Date().toISOString(),
            counts: {
                missingAssets: this.audit.missingAssets.length,
                brokenInternalLinks: this.audit.brokenInternalLinks.length,
                redirects: this.audit.redirects.length,
                mimeMismatches: this.audit.mimeMismatches.length,
            },
            missingAssets: this.audit.missingAssets,
            brokenInternalLinks: this.audit.brokenInternalLinks,
            redirects: this.audit.redirects,
            mimeMismatches: this.audit.mimeMismatches,
        };

        await fs.writeFile(path.join(this.options.outputDir, 'run-audit.json'), JSON.stringify(report, null, 2), 'utf8');
        return report;
    }
}

function buildCrawlerOptions(input) {
    const parsed = new URL(input.targetUrl);
    const runName = `${parsed.hostname}-${Date.now()}`;
    const outputDir = path.join(input.baseOutputDir, runName);

    return {
        startUrl: input.targetUrl,
        outputDir,
        maxPages: input.maxPages,
        maxDepth: input.maxDepth,
        delayMinMs: input.delayMinMs,
        delayMaxMs: input.delayMaxMs,
        respectRobots: input.respectRobots,
        saveExternalAssets: input.saveExternalAssets,
        singlePage: input.singlePage,
        auth: input.auth,
        userAgent: DEFAULT_UA[rand(0, DEFAULT_UA.length - 1)],
    };
}

module.exports = {
    PlaywrightCrawler,
    buildCrawlerOptions,
};
