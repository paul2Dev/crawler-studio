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
    shouldSkipLinkForCrawl,
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
            domAssetDirectLimit: 40,
            domAssetDirectConcurrency: 6,
            directAssetTimeoutMs: 6000,
            ...options,
        };
        this.onProgress = onProgress;
        this.pageMap = new Map();
        this.assetMap = new Map();
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

        const queue = [{ url: startUrl, depth: 0 }];

        try {
            while (queue.length && this.visited.size < this.options.maxPages) {
                this.ensureNotStopped();
                const current = queue.shift();
                const currentUrl = normalizeUrl(current.url);

                if (this.visited.has(currentUrl)) continue;
                if (current.depth > this.options.maxDepth) continue;
                if (shouldSkipLinkForCrawl(currentUrl)) {
                    this.onProgress({ level: 'warn', message: `Ignor URL template invalid: ${currentUrl}` });
                    continue;
                }
                if (!robots.canFetch(currentUrl)) {
                    this.onProgress({ level: 'warn', message: `Blocat de robots.txt: ${currentUrl}` });
                    continue;
                }

                this.visited.add(currentUrl);
                this.onProgress({ level: 'info', message: `Vizitez ${this.visited.size}/${this.options.maxPages}: ${currentUrl}` });

                if (isLikelyDownloadUrl(currentUrl)) {
                    await this.downloadAssetDirect(currentUrl);
                    this.onProgress({ level: 'info', message: `URL de download tratat ca asset: ${currentUrl}` });

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
                        if (isDownloadStartingError(error) || isLikelyDownloadUrl(currentUrl)) {
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
                        for (const link of links) {
                            if (!this.visited.has(link)) {
                                queue.push({ url: link, depth: current.depth + 1 });
                            }
                        }
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

        const htmlFolder = path.join(this.options.outputDir, 'html');
        const startPagePath = this.pageMap.get(startUrl);
        const startPageFile = startPagePath
            ? path.relative(htmlFolder, startPagePath).split(path.sep).join('/')
            : null;
        const archiveIndexFile = await this.writeIndex(startUrl);
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
        return finalPath;
    }

    ensureUnique(filePath, seed) {
        if (!fss.existsSync(filePath)) return filePath;
        const parsed = path.parse(filePath);
        const tail = crypto.createHash('md5').update(seed).digest('hex').slice(0, 7);
        return path.join(parsed.dir, `${parsed.name}-${tail}${parsed.ext}`);
    }

    rewriteHtml(html, currentUrl, currentHtmlPath, responseAssets, startUrl) {
        const $ = cheerio.load(html);

        // Browsers frequently block module/crossorigin/integrity resources under file://
        // (origin is null). Dropping these attrs improves direct-open compatibility.
        $('script[type="module"]').removeAttr('type');
        $('script[crossorigin], link[crossorigin]').removeAttr('crossorigin');
        $('script[integrity], link[integrity]').removeAttr('integrity');

        const rewrite = (selector, attr) => {
            $(selector).each((_, el) => {
                const raw = $(el).attr(attr);
                if (!raw) return;
                if (/^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) return;

                let absolute;
                try {
                    absolute = normalizeUrl(new URL(raw, currentUrl).toString());
                } catch {
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
                    if (looksLikeAssetUrl(absolute) || isLikelyDownloadUrl(absolute)) {
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

        return $.html();
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
                if (!looksLikeAssetUrl(absolute) && !isLikelyDownloadUrl(absolute)) return;
                if (!isSameHost(startUrl, absolute) && !this.options.saveExternalAssets) return;
                assets.add(absolute);
            });
        }

        return [...assets];
    }

    async downloadAssetDirect(assetUrl) {
        if (this.assetMap.has(assetUrl)) return;
        try {
            const ac = new AbortController();
            const timeout = setTimeout(() => ac.abort(), this.options.directAssetTimeoutMs);
            const res = await fetch(assetUrl, {
                headers: {
                    'User-Agent': this.options.userAgent,
                    'Accept-Language': 'ro,en;q=0.8',
                },
                redirect: 'follow',
                signal: ac.signal,
            });
            clearTimeout(timeout);
            if (!res.ok) return;

            const body = Buffer.from(await res.arrayBuffer());
            if (!body.length) return;

            const contentType = res.headers.get('content-type') || '';
            const mismatch = detectMimeMismatch(assetUrl, contentType);
            if (mismatch) {
                this.addAuditEntry('mimeMismatches', `${assetUrl}|${mismatch.contentType}`, {
                    pageUrl: null,
                    ...mismatch,
                });
            }
            const fakeResponse = {
                headers() {
                    return { 'content-type': contentType };
                },
            };

            const localPath = this.localAssetPath(assetUrl, fakeResponse);
            await fs.mkdir(path.dirname(localPath), { recursive: true });
            if (!fss.existsSync(localPath)) {
                await fs.writeFile(localPath, body);
            }
        } catch {
            // Direct asset download failures should not stop crawl.
        }
    }

    async downloadDomAssets(html, currentUrl, startUrl) {
        const urls = this.collectDomAssetUrls(html, currentUrl, startUrl);
        // Keep this bounded so per-page capture stays responsive.
        const limit = Math.min(urls.length, this.options.domAssetDirectLimit);
        const selected = urls.slice(0, limit);
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
                        if (!looksLikeAssetUrl(absolute) && !isLikelyDownloadUrl(absolute)) continue;
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
        userAgent: DEFAULT_UA[rand(0, DEFAULT_UA.length - 1)],
    };
}

module.exports = {
    PlaywrightCrawler,
    buildCrawlerOptions,
};
