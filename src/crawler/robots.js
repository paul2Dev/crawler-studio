function parseRobotsTxt(content) {
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    const disallow = [];
    const allow = [];

    let active = false;
    for (const line of lines) {
        if (!line || line.startsWith('#')) continue;

        const [keyPart, ...rest] = line.split(':');
        const key = keyPart.trim().toLowerCase();
        const value = rest.join(':').trim();

        if (key === 'user-agent') {
            active = value === '*';
            continue;
        }

        if (!active) continue;
        if (key === 'allow' && value) allow.push(value);
        if (key === 'disallow' && value) disallow.push(value);
    }

    return { allow, disallow };
}

async function loadRobotsPolicy(origin, userAgent) {
    const robotsUrl = new URL('/robots.txt', origin).toString();

    try {
        const response = await fetch(robotsUrl, {
            headers: { 'User-Agent': userAgent },
            redirect: 'follow',
        });

        if (!response.ok) {
            return {
                robotsUrl,
                found: false,
                crawlDelayMs: 1000,
                canFetch: () => true,
            };
        }

        const text = await response.text();
        const policy = parseRobotsTxt(text);

        return {
            robotsUrl,
            found: true,
            crawlDelayMs: 1000,
            canFetch(url) {
                const path = new URL(url).pathname || '/';
                if (policy.allow.some((rule) => path.startsWith(rule))) return true;
                if (policy.disallow.some((rule) => path.startsWith(rule))) return false;
                return true;
            },
        };
    } catch {
        return {
            robotsUrl,
            found: false,
            crawlDelayMs: 1000,
            canFetch: () => true,
        };
    }
}

module.exports = { loadRobotsPolicy };
