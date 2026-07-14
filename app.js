const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const archiver = require('archiver');

const { JobManager } = require('./src/job-manager');

const app = express();
const manager = new JobManager(path.join(__dirname, 'output-runs'));
const port = Number(process.env.PORT || 3010);
const OUTPUT_RUNS_DIR = path.join(__dirname, 'output-runs');
const CRAWL_DELAY_MIN_RECOMMENDED = 700;
const CRAWL_DELAY_MAX_RECOMMENDED = 1500;

function normalizeInteger(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeText(value) {
    return String(value || '').trim();
}

function toBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function toBase64Url(value) {
    return Buffer.from(String(value || ''), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function runNameFromReferer(req) {
    const referer = String(req.get('referer') || '').trim();
    if (!referer) return null;

    try {
        const url = new URL(referer);
        const match = String(url.pathname || '').match(/^\/runs\/([a-zA-Z0-9._-]+)(?:\/|$)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

function readCookie(req, key) {
    const source = String(req.get('cookie') || '');
    if (!source) return null;

    const parts = source.split(';');
    for (const part of parts) {
        const [rawKey, ...rest] = part.trim().split('=');
        if (rawKey !== key) continue;
        return decodeURIComponent(rest.join('=') || '');
    }
    return null;
}

function runNameFromRequestContext(req) {
    const fromReferer = runNameFromReferer(req);
    if (fromReferer) return fromReferer;

    const fromCookie = readCookie(req, 'crawler_run');
    if (fromCookie && /^[a-zA-Z0-9._-]+$/.test(fromCookie)) {
        return fromCookie;
    }

    return null;
}

function safeRunDir(runName) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(runName || ''))) return null;
    const dir = path.resolve(OUTPUT_RUNS_DIR, runName);
    const expectedRoot = `${path.resolve(OUTPUT_RUNS_DIR)}${path.sep}`;
    return dir.startsWith(expectedRoot) ? dir : null;
}

async function resolveNuxtFallbackAsset(runName, reqPath, search) {
    const runDir = safeRunDir(runName);
    if (!runDir) return null;

    const cleanPath = String(reqPath || '').split('?')[0].trim();
    const cleanSearch = String(search || '');

    // Nuxt runtime metadata endpoint: /_nuxt/builds/meta/<id>.json
    if (/^\/_nuxt\/builds\/meta\/[^/]+\.json$/i.test(cleanPath)) {
        const metaId = path.basename(cleanPath, '.json');
        const metaFile = path.join(runDir, 'files', `${metaId}.json`);
        const stat = await fs.stat(metaFile).catch(() => null);
        if (stat && stat.isFile()) return metaFile;
    }

    // Nuxt payload endpoint variants: /_payload.json?<buildId>, /about/_payload.json?<buildId>, etc.
    if (/\/_payload\.json$/i.test(cleanPath)) {
        const token = cleanSearch ? `?${cleanSearch.replace(/^\?/, '')}` : '';
        const filesDir = path.join(runDir, 'files');

        // Build deterministic candidate names from request path and query.
        const baseEncoded = token ? toBase64Url(token).slice(0, 12) : '';
        const baseName = baseEncoded ? `_payload-${baseEncoded}.json` : '_payload.json';

        const summary = await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8').catch(() => '');
        let origin = '';
        try {
            const parsed = JSON.parse(summary || '{}');
            const startUrl = parsed && Array.isArray(parsed.pages) && parsed.pages[0] && parsed.pages[0].url
                ? String(parsed.pages[0].url)
                : '';
            origin = startUrl ? new URL(startUrl).origin : '';
        } catch {
            origin = '';
        }

        if (origin && baseEncoded) {
            const absolute = new URL(`${cleanPath}${token}`, origin).toString();
            const tail = crypto.createHash('md5').update(absolute).digest('hex').slice(0, 7);
            const withTail = `_payload-${baseEncoded}-${tail}.json`;
            const withTailFile = path.join(filesDir, withTail);
            const withTailStat = await fs.stat(withTailFile).catch(() => null);
            if (withTailStat && withTailStat.isFile()) return withTailFile;
        }

        if (baseEncoded) {
            const exactFile = path.join(filesDir, baseName);
            const exactStat = await fs.stat(exactFile).catch(() => null);
            if (exactStat && exactStat.isFile()) return exactFile;
        }

        const files = await fs.readdir(filesDir).catch(() => []);
        if (token) {
            const encoded = toBase64Url(token).slice(0, 12);
            const prefix = `_payload-${encoded}`;
            const prefixed = files.find((name) => name.startsWith(prefix) && name.endsWith('.json'));
            if (prefixed) return path.join(runDir, 'files', prefixed);
        }

        const genericPayload = files.find((name) => /^_payload-.*\.json$/i.test(name));
        if (genericPayload) return path.join(runDir, 'files', genericPayload);

        const fallbackFile = path.join(runDir, 'files', '_payload.json');
        const fallbackStat = await fs.stat(fallbackFile).catch(() => null);
        if (fallbackStat && fallbackStat.isFile()) return fallbackFile;
    }

    // Absolute /_nuxt/* files that are rewritten into run-local js/css/fonts/images folders.
    if (/^\/_nuxt\//i.test(cleanPath)) {
        const requestedName = path.basename(cleanPath).split('?')[0];
        const ext = path.extname(requestedName).toLowerCase();
        const nameBase = path.parse(requestedName).name;
        const folderByExt = {
            '.js': 'js',
            '.mjs': 'js',
            '.css': 'css',
            '.woff': 'fonts',
            '.woff2': 'fonts',
            '.ttf': 'fonts',
            '.otf': 'fonts',
            '.eot': 'fonts',
            '.svg': 'images',
            '.png': 'images',
            '.jpg': 'images',
            '.jpeg': 'images',
            '.webp': 'images',
            '.gif': 'images',
            '.ico': 'images',
            '.json': 'files',
        };

        const targetFolder = folderByExt[ext];
        if (!targetFolder) return null;

        const folderPath = path.join(runDir, targetFolder);
        const entries = await fs.readdir(folderPath).catch(() => []);
        const exact = entries.find((name) => name === requestedName);
        if (exact) return path.join(folderPath, exact);

        // Crawler may append a deterministic suffix (e.g. -P3Y9...) to avoid collisions.
        const withSuffix = entries.find((name) => {
            if (!name.endsWith(ext)) return false;
            return name === `${nameBase}${ext}` || name.startsWith(`${nameBase}-`);
        });
        if (withSuffix) return path.join(folderPath, withSuffix);
    }

    return null;
}

function validateCrawlDelays(rawMin, rawMax) {
    const minDelay = normalizeInteger(rawMin, Number.NaN);
    const maxDelay = normalizeInteger(rawMax, Number.NaN);

    if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay)) {
        return { valid: false, error: 'Delay minim si delay maxim trebuie sa fie numere valide.' };
    }
    if (minDelay < CRAWL_DELAY_MIN_RECOMMENDED) {
        return { valid: false, error: `Delay minim trebuie sa fie cel putin ${CRAWL_DELAY_MIN_RECOMMENDED}ms.` };
    }
    if (maxDelay < CRAWL_DELAY_MAX_RECOMMENDED) {
        return { valid: false, error: `Delay maxim trebuie sa fie cel putin ${CRAWL_DELAY_MAX_RECOMMENDED}ms.` };
    }
    if (maxDelay < minDelay) {
        return { valid: false, error: 'Delay maxim nu poate fi mai mic decat delay minim.' };
    }

    return { valid: true, minDelay, maxDelay };
}

function parseAuthConfig(body) {
    const authBody = body && typeof body.auth === 'object' && body.auth !== null ? body.auth : {};
    const enabled = toBoolean(body?.authEnabled) || toBoolean(authBody.enabled);
    if (!enabled) return { enabled: false };

    const username = normalizeText(body?.authUsername ?? authBody.username);
    const password = String(body?.authPassword ?? authBody.password ?? '');
    const loginUrlInput = normalizeText(body?.authLoginUrl ?? authBody.loginUrl);
    const loginUrlRaw = loginUrlInput || normalizeText(body?.targetUrl);
    const openModalSelector = normalizeText(body?.authOpenModalSelector ?? authBody.openModalSelector);
    const confirmSelector = normalizeText(body?.authConfirmSelector ?? authBody.confirmSelector);
    const usernameSelector = normalizeText(body?.authUsernameSelector ?? authBody.usernameSelector)
        || 'input[name="username"], input[type="email"], #username';
    const passwordSelector = normalizeText(body?.authPasswordSelector ?? authBody.passwordSelector)
        || 'input[name="password"], input[type="password"], #password';
    const submitSelector = normalizeText(body?.authSubmitSelector ?? authBody.submitSelector)
        || 'button[type="submit"], input[type="submit"]';
    const successUrlContains = normalizeText(body?.authSuccessUrlContains ?? authBody.successUrlContains);
    const waitAfterLoginMs = Math.max(0, Math.min(15000, normalizeInteger(body?.authWaitAfterLoginMs ?? authBody.waitAfterLoginMs, 1200)));

    if (!username) {
        return { error: 'Pentru login, campul utilizator este obligatoriu.' };
    }
    if (!password) {
        return { error: 'Pentru login, campul parola este obligatoriu.' };
    }
    if (!loginUrlRaw) {
        return { error: 'Pentru login, URL-ul paginii de autentificare este obligatoriu.' };
    }

    let loginUrl;
    try {
        const parsed = new URL(loginUrlRaw);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { error: 'URL-ul de login trebuie sa fie http/https.' };
        }
        loginUrl = parsed.toString();
    } catch (error) {
        return { error: `URL login invalid: ${error.message}` };
    }

    return {
        enabled: true,
        username,
        password,
        loginUrl,
        openModalSelector,
        confirmSelector,
        usernameSelector,
        passwordSelector,
        submitSelector,
        successUrlContains,
        waitAfterLoginMs,
    };
}

function redactCrawlInput(input) {
    if (!input || typeof input !== 'object') return input;
    if (!input.auth || typeof input.auth !== 'object') return input;

    const redactedAuth = {
        ...input.auth,
        password: input.auth.password ? '***' : '',
    };
    return { ...input, auth: redactedAuth };
}

async function fileExists(filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    return Boolean(stat && stat.isFile());
}

async function resolveRunWebPath(runDir, runName) {
    const htmlDir = path.join(runDir, 'html');
    const indexFile = path.join(htmlDir, 'index.html');
    const summaryFile = path.join(runDir, 'run-summary.json');
    const indexContent = await fs.readFile(indexFile, 'utf8').catch(() => '');
    const isGeneratedArchiveIndex = indexContent.includes('Crawler Studio Export');

    const summary = await fs.readFile(summaryFile, 'utf8').catch(() => '');
    let parsedSummary = null;
    try {
        parsedSummary = summary ? JSON.parse(summary) : null;
    } catch {
        parsedSummary = null;
    }

    if (!isGeneratedArchiveIndex && await fileExists(indexFile)) {
        return `/runs/${runName}/html/index.html`;
    }

    const summaryPages = Array.isArray(parsedSummary?.pages) ? parsedSummary.pages : [];
    for (const p of summaryPages) {
        if (!p || !p.file || p.file === 'index.html') continue;
        const candidate = path.join(htmlDir, p.file);
        if (await fileExists(candidate)) {
            return `/runs/${runName}/html/${p.file}`;
        }
    }

    if (await fileExists(path.join(htmlDir, 'archive-index.html'))) {
        return `/runs/${runName}/html/archive-index.html`;
    }

    if (await fileExists(indexFile)) {
        return `/runs/${runName}/html/index.html`;
    }

    return null;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/runs', express.static(OUTPUT_RUNS_DIR, {
    setHeaders(res, filePath) {
        const normalized = filePath.toLowerCase().replace(/\\/g, '/');

        // Archived files often have transformed names (e.g. app.css-P2lk...),
        // so extension-based MIME detection can fail. Use folder-based mapping.
        if (normalized.includes('/output-runs/') && normalized.includes('/css/')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return;
        }
        if (normalized.includes('/output-runs/') && normalized.includes('/js/')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return;
        }
        if (normalized.includes('/output-runs/') && normalized.includes('/images/')) {
            if (normalized.includes('.svg')) {
                res.setHeader('Content-Type', 'image/svg+xml');
            } else if (normalized.includes('.webp')) {
                res.setHeader('Content-Type', 'image/webp');
            } else if (normalized.includes('.png')) {
                res.setHeader('Content-Type', 'image/png');
            } else if (normalized.includes('.gif')) {
                res.setHeader('Content-Type', 'image/gif');
            } else {
                res.setHeader('Content-Type', 'image/jpeg');
            }
            return;
        }
        if (normalized.includes('/output-runs/') && normalized.includes('/fonts/')) {
            if (normalized.includes('.woff2')) {
                res.setHeader('Content-Type', 'font/woff2');
            } else if (normalized.includes('.woff')) {
                res.setHeader('Content-Type', 'font/woff');
            } else if (normalized.includes('.ttf')) {
                res.setHeader('Content-Type', 'font/ttf');
            } else if (normalized.includes('.otf')) {
                res.setHeader('Content-Type', 'font/otf');
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
            }
            return;
        }
        if (normalized.includes('/output-runs/') && normalized.includes('/videos/')) {
            res.setHeader('Content-Type', 'video/mp4');
            return;
        }
        if (normalized.includes('/output-runs/') && normalized.includes('/audio/')) {
            res.setHeader('Content-Type', 'audio/mpeg');
            return;
        }
    },
}));

app.use('/runs/:runName', (req, res, next) => {
    const runName = String(req.params.runName || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(runName)) {
        return next();
    }

    // Keep current run context for runtime absolute Nuxt requests that may omit Referer.
    res.setHeader('Set-Cookie', `crawler_run=${encodeURIComponent(runName)}; Path=/; SameSite=Lax`);
    return next();
});

app.get('/runs/:runName/js/:fileName', async (req, res, next) => {
    try {
        const runName = String(req.params.runName || '');
        const fileName = String(req.params.fileName || '');
        if (!/\.css$/i.test(fileName)) {
            return next();
        }

        const runDir = safeRunDir(runName);
        if (!runDir) return next();

        const cssDir = path.join(runDir, 'css');
        const entries = await fs.readdir(cssDir).catch(() => []);
        const exact = entries.find((name) => name === fileName);
        if (exact) return res.sendFile(path.join(cssDir, exact));

        const ext = path.extname(fileName).toLowerCase();
        const base = path.parse(fileName).name;
        const withSuffix = entries.find((name) => name.endsWith(ext) && (name === `${base}${ext}` || name.startsWith(`${base}-`)));
        if (withSuffix) return res.sendFile(path.join(cssDir, withSuffix));

        return next();
    } catch {
        return next();
    }
});

app.get([/^\/(?:.+\/)?_payload\.json$/i, '/_nuxt/*'], async (req, res, next) => {
    try {
        const runName = runNameFromRequestContext(req);
        if (!runName) return next();

        const filePath = await resolveNuxtFallbackAsset(runName, req.path, req.url.includes('?') ? req.url.split('?')[1] : '');
        if (!filePath) return next();

        return res.sendFile(filePath);
    } catch {
        return next();
    }
});

app.get('/api/runs', async (_req, res) => {
    try {
        const entries = await fs.readdir(OUTPUT_RUNS_DIR, { withFileTypes: true });
        const runs = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const htmlIndex = path.join(OUTPUT_RUNS_DIR, entry.name, 'html', 'index.html');
            const dirPath = path.join(OUTPUT_RUNS_DIR, entry.name);
            const dirStat = await fs.stat(dirPath);
            const indexStat = await fs.stat(htmlIndex).catch(() => null);
            const webPath = await resolveRunWebPath(dirPath, entry.name);

            runs.push({
                name: entry.name,
                webPath,
                hasIndex: Boolean(indexStat),
                createdAt: (indexStat || dirStat).mtime.toISOString(),
            });
        }

        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        res.json({ runs });
    } catch {
        res.json({ runs: [] });
    }
});

app.delete('/api/runs/:runName', async (req, res) => {
    const runName = String(req.params.runName || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(runName)) {
        return res.status(400).json({ error: 'Nume arhiva invalid.' });
    }

    const runDir = path.resolve(OUTPUT_RUNS_DIR, runName);
    const expectedRoot = `${path.resolve(OUTPUT_RUNS_DIR)}${path.sep}`;
    if (!runDir.startsWith(expectedRoot)) {
        return res.status(400).json({ error: 'Cale arhiva invalida.' });
    }

    try {
        const stat = await fs.stat(runDir).catch(() => null);
        if (!stat || !stat.isDirectory()) {
            return res.status(404).json({ error: 'Arhiva nu exista.' });
        }

        await fs.rm(runDir, { recursive: true, force: false });
        return res.json({ deleted: true, runName });
    } catch (error) {
        return res.status(500).json({ error: `Nu am putut sterge arhiva: ${error.message}` });
    }
});

app.get('/api/runs/:runName/zip', async (req, res) => {
    const runName = String(req.params.runName || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(runName)) {
        return res.status(400).json({ error: 'Nume arhiva invalid.' });
    }

    const runDir = path.resolve(OUTPUT_RUNS_DIR, runName);
    const expectedRoot = `${path.resolve(OUTPUT_RUNS_DIR)}${path.sep}`;
    if (!runDir.startsWith(expectedRoot)) {
        return res.status(400).json({ error: 'Cale arhiva invalida.' });
    }

    const stat = await fs.stat(runDir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
        return res.status(404).json({ error: 'Arhiva nu exista.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${runName}.zip"`);

    const archive = typeof archiver === 'function'
        ? archiver('zip', { zlib: { level: 9 } })
        : new archiver.ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (error) => {
        if (!res.headersSent) {
            res.status(500).json({ error: `Nu am putut genera ZIP: ${error.message}` });
            return;
        }
        res.destroy(error);
    });

    archive.pipe(res);
    archive.directory(runDir, runName);
    archive.finalize();
    return undefined;
});

app.get('/api/status', (_req, res) => {
    res.json(manager.getStatus());
});

app.post('/api/stop', (_req, res) => {
    const result = manager.stopCurrentJob();
    if (!result.stopped) {
        return res.status(409).json(result);
    }
    return res.json(result);
});

app.post('/api/crawl', async (req, res) => {
    const body = req.body || {};

    try {
        const targetUrl = String(body.targetUrl || '').trim();
        if (!targetUrl) {
            return res.status(400).json({ error: 'targetUrl este obligatoriu.' });
        }

        const parsed = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Doar URL-uri http/https sunt permise.' });
        }

        const delays = validateCrawlDelays(body.delayMinMs, body.delayMaxMs);
        if (!delays.valid) {
            return res.status(400).json({ error: delays.error });
        }

        const singlePageMode = toBoolean(body.singlePage);
        const auth = parseAuthConfig(body);
        if (auth.error) {
            return res.status(400).json({ error: auth.error });
        }

        const input = {
            targetUrl: parsed.toString(),
            maxPages: singlePageMode ? 1 : Math.max(1, normalizeInteger(body.maxPages, 150)),
            maxDepth: singlePageMode ? 0 : Math.max(1, normalizeInteger(body.maxDepth, 3)),
            delayMinMs: delays.minDelay,
            delayMaxMs: delays.maxDelay,
            respectRobots: body.respectRobots !== false,
            saveExternalAssets: body.saveExternalAssets === true,
            singlePage: singlePageMode,
            auth,
        };

        manager.startCrawl(input).catch(() => {
            // Status endpoint returns detailed error.
        });

        return res.status(202).json({ accepted: true, input: redactCrawlInput(input) });
    } catch (error) {
        return res.status(400).json({ error: `URL invalid: ${error.message}` });
    }
});

app.post('/api/dry-run', async (req, res) => {
    const body = req.body || {};

    try {
        const targetUrl = String(body.targetUrl || '').trim();
        if (!targetUrl) {
            return res.status(400).json({ error: 'targetUrl este obligatoriu.' });
        }

        const parsed = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Doar URL-uri http/https sunt permise.' });
        }

        const auth = parseAuthConfig(body);
        if (auth.error) {
            return res.status(400).json({ error: auth.error });
        }

        const input = {
            targetUrl: parsed.toString(),
            maxPagesProbe: Math.max(30, normalizeInteger(body.maxPagesProbe, 180)),
            maxDepthProbe: Math.max(2, normalizeInteger(body.maxDepthProbe, 6)),
            // Dry run intentionally uses lower delays for faster page graph estimation.
            delayMinMs: Math.max(60, normalizeInteger(body.delayMinMs, 120)),
            delayMaxMs: Math.max(120, normalizeInteger(body.delayMaxMs, 260)),
            // Estimate for real crawl duration uses production delays, not probe delays.
            crawlDelayMinMs: Math.max(700, normalizeInteger(body.crawlDelayMinMs, 700)),
            crawlDelayMaxMs: Math.max(1500, normalizeInteger(body.crawlDelayMaxMs, 1500)),
            respectRobots: body.respectRobots !== false,
            saveExternalAssets: false,
            auth,
        };

        manager.startDryRun(input).catch(() => {
            // Status endpoint returns detailed error.
        });

        return res.status(202).json({ accepted: true, input: redactCrawlInput(input) });
    } catch (error) {
        return res.status(400).json({ error: `URL invalid: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Crawler Studio running at http://localhost:${port}`);
});
