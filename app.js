const path = require('path');
const fs = require('fs/promises');
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

function toBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
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
        const input = {
            targetUrl: parsed.toString(),
            maxPages: singlePageMode ? 1 : Math.max(1, normalizeInteger(body.maxPages, 150)),
            maxDepth: singlePageMode ? 0 : Math.max(1, normalizeInteger(body.maxDepth, 3)),
            delayMinMs: delays.minDelay,
            delayMaxMs: delays.maxDelay,
            respectRobots: body.respectRobots !== false,
            saveExternalAssets: body.saveExternalAssets === true,
            singlePage: singlePageMode,
        };

        manager.startCrawl(input).catch(() => {
            // Status endpoint returns detailed error.
        });

        return res.status(202).json({ accepted: true, input });
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
        };

        manager.startDryRun(input).catch(() => {
            // Status endpoint returns detailed error.
        });

        return res.status(202).json({ accepted: true, input });
    } catch (error) {
        return res.status(400).json({ error: `URL invalid: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Crawler Studio running at http://localhost:${port}`);
});
