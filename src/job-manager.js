const path = require('path');
const { PlaywrightCrawler, buildCrawlerOptions } = require('./crawler/playwright-crawler');
const { SiteProfiler, buildProfilerOptions } = require('./crawler/site-profiler');

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
        return { id, mode, running: status === 'running', status, startedAt, finishedAt, logs, result, input };
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

            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = {
                ...result,
                webPath: `/runs/${runFolder}/html/${preferredEntry}`,
                auditWebPath: `/runs/${runFolder}/run-audit.json`,
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
