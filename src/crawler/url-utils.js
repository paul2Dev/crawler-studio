const path = require('path');

function extensionFromMimeType(contentType) {
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    const byType = {
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'text/csv': '.csv',
        'application/json': '.json',
        'application/zip': '.zip',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.ms-powerpoint': '.ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/svg+xml': '.svg',
        'video/mp4': '.mp4',
        'audio/mpeg': '.mp3',
        'font/woff': '.woff',
        'font/woff2': '.woff2',
        'font/ttf': '.ttf',
        'font/otf': '.otf',
        'text/css': '.css',
        'application/javascript': '.js',
        'text/javascript': '.js',
    };
    return byType[type] || '';
}

function fileNameFromContentDisposition(disposition) {
    const raw = String(disposition || '');
    if (!raw) return '';

    const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
        try {
            return path.basename(decodeURIComponent(utf8Match[1].replace(/["']/g, '').trim()));
        } catch {
            return path.basename(utf8Match[1].replace(/["']/g, '').trim());
        }
    }

    const plainMatch = raw.match(/filename=\s*"?([^";]+)"?/i);
    if (!plainMatch || !plainMatch[1]) return '';
    return path.basename(plainMatch[1].trim());
}

function sanitizePathSegment(segment) {
    const cleaned = String(segment || '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return cleaned || 'page';
}

function hasTemplatePathSegment(url) {
    const segments = String(url.pathname || '')
        .split('/')
        .filter(Boolean);
    return segments.some((seg) => seg.startsWith(':'));
}

function hasInjectedHtmlMarkers(url) {
    const rawPath = String(url.pathname || '');
    const rawQuery = String(url.search || '');
    const lowerCombined = `${rawPath}${rawQuery}`.toLowerCase();

    // Encoded HTML markers typically indicate a broken href that captured DOM fragments.
    if (lowerCombined.includes('%3c') || lowerCombined.includes('%3e')) return true;

    const decoded = (() => {
        try {
            return decodeURIComponent(`${rawPath}${rawQuery}`);
        } catch {
            return `${rawPath}${rawQuery}`;
        }
    })().toLowerCase();

    if (/[<>]/.test(decoded)) return true;
    if (/(?:\bclass\s*=|\bdata-target\s*=|\bmodal\b|<\/?div\b)/i.test(decoded)) return true;
    return false;
}

function hasSuspiciousPathLength(url) {
    const pathname = String(url.pathname || '');
    if (pathname.length > 1024) return true;

    const segments = pathname.split('/').filter(Boolean);
    return segments.some((seg) => seg.length > 220);
}

function isLikelyDownloadUrl(urlString) {
    try {
        const url = new URL(urlString);
        const pathname = String(url.pathname || '').toLowerCase();

        if (/\/downloader?-/.test(pathname)) return true;
        if (/\/download(?:\/|$)/.test(pathname)) return true;
        if (/\/attachment(?:\/|$)/.test(pathname)) return true;
        if (/\/library-content\//.test(pathname)) return true;

        if (url.searchParams.has('url_parse')) return true;
        if (url.searchParams.has('download')) return true;
        if (url.searchParams.has('attachment')) return true;

        return false;
    } catch {
        return false;
    }
}

function isLikelyAjaxDataUrl(urlString) {
    try {
        const url = new URL(urlString);
        const pathname = String(url.pathname || '').toLowerCase();

        if (url.searchParams.get('is_ajax') === '1') return true;
        if (url.searchParams.get('ajax') === '1' || url.searchParams.get('ajax') === 'true') return true;
        if (url.searchParams.get('_x_requested_with') === 'xmlhttprequest') return true;
        if (url.searchParams.get('format') === 'json') return true;
        if (pathname.includes('/ajax/')) return true;

        return false;
    } catch {
        return false;
    }
}

function shouldSkipLinkForCrawl(urlString) {
    return getSkipReasonForCrawl(urlString) !== null;
}

function getSkipReasonForCrawl(urlString) {
    try {
        const url = new URL(urlString);
        if (hasTemplatePathSegment(url)) return 'template-path';
        if (hasInjectedHtmlMarkers(url)) return 'html-fragment-in-url';
        if (hasSuspiciousPathLength(url)) return 'suspicious-path-length';
        return null;
    } catch {
        return 'invalid-url';
    }
}

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

    const normalized = cleanPath
        .replace(/^\//, '')
        .split('/')
        .filter(Boolean)
        .map(sanitizePathSegment)
        .join('-');
    return `${normalized}${querySuffix}.html`;
}

function resolveOutputAssetPath(outputDir, assetUrl, response) {
    const url = new URL(assetUrl);
    const headers = typeof response?.headers === 'function' ? response.headers() : {};
    const extFromPath = path.extname(url.pathname).toLowerCase();
    const type = String(headers['content-type'] || '').toLowerCase();
    const dispositionName = fileNameFromContentDisposition(headers['content-disposition'] || '');
    const extFromDisposition = path.extname(dispositionName).toLowerCase();
    const extFromMime = extensionFromMimeType(type);

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
    const inferredExt = extFromPath || extFromDisposition || extFromMime || '.bin';
    const preferredBaseName = dispositionName || baseName;
    const fileName = path.extname(preferredBaseName) ? preferredBaseName : `${preferredBaseName}${inferredExt}`;
    const queryTail = url.search ? `-${Buffer.from(url.search).toString('base64url').slice(0, 10)}` : '';
    const parsedName = path.parse(fileName);
    const finalName = queryTail
        ? `${parsedName.name}${queryTail}${parsedName.ext}`
        : fileName;

    return path.join(outputDir, folder, finalName);
}

function safeRelativeLink(fromHtmlPath, toPath) {
    return path.relative(path.dirname(fromHtmlPath), toPath).split(path.sep).join('/');
}

module.exports = {
    normalizeUrl,
    isSameHost,
    isLikelyDownloadUrl,
    isLikelyAjaxDataUrl,
    shouldSkipLinkForCrawl,
    getSkipReasonForCrawl,
    htmlFileNameFor,
    resolveOutputAssetPath,
    safeRelativeLink,
};
