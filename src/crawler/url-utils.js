const path = require('path');

function normalizeUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
        url.port = '';
    }
    url.pathname = url.pathname || '/';
    return url.toString();
}

function isSameHost(baseUrl, candidateUrl) {
    const base = new URL(baseUrl);
    const candidate = new URL(candidateUrl);
    return base.protocol === candidate.protocol && base.host === candidate.host;
}

function htmlFileNameFor(urlString) {
    const url = new URL(urlString);
    const cleanPath = url.pathname.replace(/\/+$/, '') || '/';
    const querySuffix = url.search ? `-${Buffer.from(url.search).toString('base64url').slice(0, 12)}` : '';

    if (cleanPath === '/') {
        return `index${querySuffix}.html`;
    }

    const normalized = cleanPath.replace(/^\//, '').replace(/\//g, '-');
    return `${normalized}${querySuffix}.html`;
}

function resolveOutputAssetPath(outputDir, assetUrl, response) {
    const url = new URL(assetUrl);
    const extFromPath = path.extname(url.pathname).toLowerCase();
    const type = String(response.headers()['content-type'] || '').toLowerCase();

    let folder = 'files';
    if (type.includes('text/css')) folder = 'css';
    else if (type.includes('javascript')) folder = 'js';
    else if (type.startsWith('image/')) folder = 'images';
    else if (type.startsWith('video/')) folder = 'videos';
    else if (type.startsWith('audio/')) folder = 'audio';
    else if (type.startsWith('font/') || type.includes('woff') || type.includes('opentype')) folder = 'fonts';
    else if (extFromPath === '.css') folder = 'css';
    else if (extFromPath === '.js' || extFromPath === '.mjs') folder = 'js';

    const pathname = url.pathname === '/' ? '/root' : url.pathname;
    const safe = pathname.replace(/^\//, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
    const baseName = safe.split('/').pop() || 'asset';
    const fileName = path.extname(baseName) ? baseName : `${baseName}${extFromPath || '.bin'}`;
    const queryTail = url.search ? `-${Buffer.from(url.search).toString('base64url').slice(0, 10)}` : '';

    return path.join(outputDir, folder, `${fileName}${queryTail}`);
}

function safeRelativeLink(fromHtmlPath, toPath) {
    return path.relative(path.dirname(fromHtmlPath), toPath).split(path.sep).join('/');
}

module.exports = {
    normalizeUrl,
    isSameHost,
    htmlFileNameFor,
    resolveOutputAssetPath,
    safeRelativeLink,
};
