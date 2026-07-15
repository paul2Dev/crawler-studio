const fs = require('fs/promises');
const path = require('path');
const { PlaywrightCrawler, buildCrawlerOptions } = require('./crawler/playwright-crawler');
const { SiteProfiler, buildProfilerOptions } = require('./crawler/site-profiler');

function formatJobLogLine(entry) {
    const level = String(entry?.level || 'info').toUpperCase();
    const ts = entry?.at ? new Date(entry.at).toISOString() : new Date().toISOString();
    const message = String(entry?.message || '').replace(/\r?\n/g, ' ');
    return `[${ts}] [${level}] ${message}`;
}

async function writeRunLogFile(outputDir, logs) {
    if (!outputDir) return;
    const lines = Array.isArray(logs) ? logs.map(formatJobLogLine) : [];
    const content = `${lines.join('\n')}\n`;
    await fs.writeFile(path.join(outputDir, 'run-log.txt'), content, 'utf8');
}

function redactCrawlInput(input) {
    if (!input || typeof input !== 'object') return input;

    const redacted = { ...input };
    if (Array.isArray(input.seedUrls)) {
        redacted.seedUrlsCount = input.seedUrls.length;
        delete redacted.seedUrls;
    }
    if (Array.isArray(input.sitemapUrls)) {
        redacted.sitemapUrlsCount = input.sitemapUrls.length;
        delete redacted.sitemapUrls;
    }

    if (!input.auth || typeof input.auth !== 'object') return redacted;

    redacted.auth = {
        ...input.auth,
        password: input.auth.password ? '***' : '',
    };
    return redacted;
}

class JobManager {
    constructor(baseOutputDir) {
        this.baseOutputDir = baseOutputDir;
        this.currentJob = null;
        this.nextId = 1;
        this.stopHandler = null;
    }

    getStatus() {
        if (!this.currentJob) {
            return { running: false };
        }

        const { id, mode, status, startedAt, finishedAt, logs, result, input } = this.currentJob;
        return {
            id,
            mode,
            running: status === 'running',
            status,
            startedAt,
            finishedAt,
            logs,
            result,
            input: redactCrawlInput(input),
        };
    }

    async startCrawl(input) {
        if (this.currentJob && this.currentJob.status === 'running') {
            throw new Error('Exista deja un job in executie.');
        }

        const job = {
            id: this.nextId++,
            mode: 'crawl',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            input,
            logs: [],
            result: null,
        };

        this.currentJob = job;

        const options = buildCrawlerOptions({
            ...input,
            baseOutputDir: this.baseOutputDir,
        });

        const crawler = new PlaywrightCrawler(options, (entry) => {
            job.logs.push({ at: new Date().toISOString(), ...entry });
            if (job.logs.length > 500) {
                job.logs.shift();
            }
        });
        this.stopHandler = () => crawler.requestStop();

        try {
            const result = await crawler.run();
            const runFolder = path.relative(this.baseOutputDir, result.outputDir).split(path.sep).join('/');
            const preferredEntry = result.startPageFile || result.archiveIndexFile || 'archive-index.html';

            await writeRunLogFile(result.outputDir, job.logs);

            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = {
                ...result,
                webPath: `/runs/${runFolder}/html/${preferredEntry}`,
                auditWebPath: `/runs/${runFolder}/run-audit.json`,
                logWebPath: `/runs/${runFolder}/run-log.txt`,
            };

            return job;
        } catch (error) {
            job.status = error.code === 'JOB_STOPPED' ? 'stopped' : 'failed';
            job.finishedAt = new Date().toISOString();
            job.result = { error: error.message };
            job.logs.push({
                at: new Date().toISOString(),
                level: error.code === 'JOB_STOPPED' ? 'warn' : 'error',
                message: error.message,
            });
            const runOutputDir = options.outputDir;
            if (runOutputDir) {
                await writeRunLogFile(runOutputDir, job.logs).catch(() => { });
            }
            throw error;
        } finally {
            this.stopHandler = null;
        }
    }

    async startDryRun(input) {
        if (this.currentJob && this.currentJob.status === 'running') {
            throw new Error('Exista deja un job in executie.');
        }

        const job = {
            id: this.nextId++,
            mode: 'dry-run',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            input,
            logs: [],
            result: null,
        };

        this.currentJob = job;

        const isSitemapMode = input && input.sourceMode === 'sitemap';
        if (isSitemapMode) {
            const urls = Array.isArray(input.sitemapUrls) ? input.sitemapUrls : [];
            job.logs.push({
                at: new Date().toISOString(),
                level: 'info',
                message: `Dry run sitemap: ${urls.length} URL-uri gasite in ${input.sitemapUrl || 'sitemap'}.`,
            });

            const pageOverheadMs = 1200;
            const minPerPage = input.crawlDelayMinMs + pageOverheadMs;
            const maxPerPage = input.crawlDelayMaxMs + pageOverheadMs;
            const avgPerPage = Math.round((minPerPage + maxPerPage) / 2);
            const minSeconds = Math.round((urls.length * minPerPage) / 1000);
            const maxSeconds = Math.round((urls.length * maxPerPage) / 1000);
            const avgSeconds = Math.round((urls.length * avgPerPage) / 1000);

            const result = {
                mode: 'dry-run',
                sourceMode: 'sitemap',
                analyzedStartUrl: input.targetUrl,
                pagesVisited: 0,
                pagesDiscovered: urls.length,
                failedPages: 0,
                maxObservedDepth: 1,
                dryRunDurationMs: 0,
                discoveredLinks: [...urls].sort((a, b) => a.localeCompare(b)),
                sitemap: {
                    url: input.sitemapUrl || '',
                    stats: input.sitemapStats || null,
                },
                estimatedCrawlTime: {
                    minSeconds,
                    maxSeconds,
                    avgSeconds,
                    assumptions: {
                        crawlDelayMinMs: input.crawlDelayMinMs,
                        crawlDelayMaxMs: input.crawlDelayMaxMs,
                        pageOverheadMs,
                    },
                },
                recommendations: {
                    maxDepth: Math.max(2, Math.min(12, Number(input.maxDepthProbe) || 8)),
                    maxPages: Math.max(60, Math.ceil(urls.length * 1.1)),
                },
                probeLimits: {
                    maxPagesProbe: input.maxPagesProbe,
                    maxDepthProbe: input.maxDepthProbe,
                },
            };

            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = result;
            return job;
        }

        const options = buildProfilerOptions(input);
        const profiler = new SiteProfiler(options, (entry) => {
            job.logs.push({ at: new Date().toISOString(), ...entry });
            if (job.logs.length > 500) {
                job.logs.shift();
            }
        });
        this.stopHandler = () => profiler.requestStop();

        try {
            const result = await profiler.run();
            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = result;
            return job;
        } catch (error) {
            job.status = error.code === 'JOB_STOPPED' ? 'stopped' : 'failed';
            job.finishedAt = new Date().toISOString();
            job.result = { error: error.message };
            job.logs.push({
                at: new Date().toISOString(),
                level: error.code === 'JOB_STOPPED' ? 'warn' : 'error',
                message: error.message,
            });
            throw error;
        } finally {
            this.stopHandler = null;
        }
    }

    stopCurrentJob() {
        if (!this.currentJob || this.currentJob.status !== 'running') {
            return { stopped: false, message: 'Nu exista job activ in rulare.' };
        }

        this.currentJob.status = 'stopping';
        this.currentJob.logs.push({ at: new Date().toISOString(), level: 'warn', message: 'Cerere de oprire primita.' });
        if (this.stopHandler) {
            this.stopHandler();
        }

        return { stopped: true, message: 'Oprirea jobului a fost declansata.' };
    }
}

module.exports = { JobManager };
