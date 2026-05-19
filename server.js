const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');
const ping = require('ping');
const bcrypt = require('bcrypt');

const DEFAULT_PORT = 5000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const MAC_PATTERN = /^[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i;

function isValidMac(mac) {
    return typeof mac === 'string' && MAC_PATTERN.test(mac.trim());
}

function isValidIp(ip) {
    return typeof ip === 'string' && net.isIP(ip.trim()) !== 0;
}

function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];

    return devices
        .map((device, index) => ({
            id: String(index),
            name: typeof device.name === 'string' && device.name.trim() ? device.name.trim() : `Device ${index + 1}`,
            mac: typeof device.mac === 'string' ? device.mac.trim() : '',
            ip: typeof device.ip === 'string' ? device.ip.trim() : ''
        }))
        .filter((device) => isValidMac(device.mac) && isValidIp(device.ip));
}

async function loadDevices(devicesFile = DEVICES_FILE) {
    try {
        const data = await fs.promises.readFile(devicesFile, 'utf-8');
        return normalizeDevices(JSON.parse(data));
    } catch (error) {
        console.error('無法讀取 devices.json:', error);
        return [];
    }
}

function publicDevice(device) {
    return {
        id: device.id,
        name: device.name,
        ip: device.ip
    };
}

function sendMagicPacket(mac, execFileImpl = execFile) {
    return new Promise((resolve, reject) => {
        if (!isValidMac(mac)) {
            reject(new Error('Invalid MAC address'));
            return;
        }

        execFileImpl('wakeonlan', [mac], (error, stdout, stderr) => {
            if (error) {
                console.error(`執行 wakeonlan 失敗: ${stderr}`);
                reject(error);
                return;
            }

            resolve(stdout);
        });
    });
}

function createSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now() } = {}) {
    const sessions = new Map();

    function cleanup() {
        const currentTime = now();
        for (const [token, session] of sessions.entries()) {
            if (session.expiresAt <= currentTime) {
                sessions.delete(token);
            }
        }
    }

    return {
        create() {
            cleanup();
            const token = crypto.randomBytes(32).toString('base64url');
            sessions.set(token, { expiresAt: now() + ttlMs });
            return token;
        },
        isValid(token) {
            cleanup();
            return typeof token === 'string' && sessions.has(token);
        },
        destroy(token) {
            sessions.delete(token);
        }
    };
}

function createLoginRateLimiter({
    maxAttempts = DEFAULT_MAX_LOGIN_ATTEMPTS,
    windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
    now = () => Date.now()
} = {}) {
    const attempts = new Map();

    function getRecord(key) {
        const currentTime = now();
        const record = attempts.get(key);
        if (!record || record.resetAt <= currentTime) {
            const freshRecord = { count: 0, resetAt: currentTime + windowMs };
            attempts.set(key, freshRecord);
            return freshRecord;
        }
        return record;
    }

    return {
        isBlocked(key) {
            return getRecord(key).count >= maxAttempts;
        },
        recordFailure(key) {
            getRecord(key).count += 1;
        },
        recordSuccess(key) {
            attempts.delete(key);
        }
    };
}

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, part) => {
        const [rawName, ...valueParts] = part.trim().split('=');
        if (!rawName || valueParts.length === 0) return cookies;
        try {
            cookies[rawName] = decodeURIComponent(valueParts.join('='));
        } catch (error) {
            cookies[rawName] = '';
        }
        return cookies;
    }, {});
}

function createSessionCookie(token, req) {
    const maxAge = Math.floor(DEFAULT_SESSION_TTL_MS / 1000);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `wol_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function createExpiredSessionCookie() {
    return 'wol_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

function addSecurityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
}

function safeSend(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
}

function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;

    try {
        const originHost = new URL(origin).host;
        const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        const allowedHosts = new Set([req.headers.host, forwardedHost].filter(Boolean));
        return allowedHosts.has(originHost);
    } catch (error) {
        return false;
    }
}

function closeUnauthorizedWebSocket(ws, reason, req) {
    console.warn('WebSocket rejected:', {
        reason,
        host: req.headers.host,
        forwardedHost: req.headers['x-forwarded-host'],
        origin: req.headers.origin,
        hasCookie: Boolean(req.headers.cookie)
    });
    ws.close(1008, reason);
}

function createJobStore({ loadDevicesImpl = loadDevices, sendMagicPacketImpl = sendMagicPacket } = {}) {
    const jobs = new Map();

    function append(job, message) {
        job.logs.push(message);
        for (const client of job.clients) {
            safeSend(client, { type: 'log', jobId: job.id, message });
        }
    }

    function complete(job, success) {
        job.status = 'done';
        job.success = success;
        for (const client of job.clients) {
            safeSend(client, { type: 'done', jobId: job.id, success });
        }
        setTimeout(() => jobs.delete(job.id), 15 * 60 * 1000).unref();
    }

    async function run(job) {
        try {
            const devices = await loadDevicesImpl();
            const device = devices.find((candidate) => candidate.id === job.deviceId);
            if (!device) {
                append(job, '錯誤：找不到指定裝置。');
                complete(job, false);
                return;
            }

            const initialProbe = await ping.promise.probe(device.ip, { timeout: 2 });
            if (initialProbe.alive) {
                append(job, `${device.name} 已經是醒著的。`);
                complete(job, true);
                return;
            }

            await sendMagicPacketImpl(device.mac);
            append(job, `喚醒指令已送出，等待 ${device.name} 回應...`);

            let isAwake = false;
            const attempts = 15;
            const interval = 6000;
            for (let i = 0; i < attempts; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, interval));
                const probe = await ping.promise.probe(device.ip, { timeout: 2 });
                if (probe.alive) {
                    append(job, `Ping ${i + 1}: 已回應。`);
                    isAwake = true;
                    break;
                }
                append(job, `Ping ${i + 1}: 尚未回應。`);
            }

            if (!isAwake) {
                append(job, `${device.name} 在指定時間內沒有回應。`);
            }
            complete(job, isAwake);
        } catch (error) {
            console.error('喚醒工作失敗:', error);
            append(job, '伺服器內部錯誤。');
            complete(job, false);
        }
    }

    return {
        create(deviceId, ws) {
            const job = {
                id: crypto.randomUUID(),
                deviceId,
                logs: [],
                clients: new Set([ws]),
                status: 'running',
                success: null
            };
            jobs.set(job.id, job);
            safeSend(ws, { type: 'job-started', jobId: job.id });
            run(job);
            return job.id;
        },
        attach(jobId, ws) {
            const job = jobs.get(jobId);
            if (!job) {
                safeSend(ws, { type: 'resume-miss', jobId });
                return;
            }

            job.clients.add(ws);
            safeSend(ws, { type: 'job-started', jobId: job.id });
            for (const message of job.logs) {
                safeSend(ws, { type: 'log', jobId: job.id, message });
            }
            if (job.status === 'done') {
                safeSend(ws, { type: 'done', jobId: job.id, success: job.success });
            }
        },
        detach(ws) {
            for (const job of jobs.values()) {
                job.clients.delete(ws);
            }
        }
    };
}

function requireSession(sessions) {
    return (req, res, next) => {
        const token = parseCookies(req.headers.cookie).wol_session;
        if (!sessions.isValid(token)) {
            res.status(401).json({ success: false, message: '請重新登入。' });
            return;
        }
        req.sessionToken = token;
        next();
    };
}

function createApp({
    hashedPassword,
    devicesFile = DEVICES_FILE,
    sessions = createSessionStore(),
    rateLimiter = createLoginRateLimiter()
} = {}) {
    if (!hashedPassword) {
        throw new Error('Missing hashedPassword');
    }

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(addSecurityHeaders);
    app.use(express.json({ limit: '10kb' }));
    app.use(express.static(path.join(__dirname, 'public')));

    app.post('/api/login', async (req, res) => {
        const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
        if (rateLimiter.isBlocked(clientKey)) {
            res.status(429).json({ success: false, message: '登入嘗試過多，請稍後再試。' });
            return;
        }

        const isMatch = await bcrypt.compare(String(req.body.password || ''), hashedPassword);
        if (!isMatch) {
            rateLimiter.recordFailure(clientKey);
            res.status(401).json({ success: false, message: '密碼錯誤。' });
            return;
        }

        rateLimiter.recordSuccess(clientKey);
        const token = sessions.create();
        res.setHeader('Set-Cookie', createSessionCookie(token, req));
        const devices = await loadDevices(devicesFile);
        res.json({ success: true, devices: devices.map(publicDevice) });
    });

    app.get('/api/devices', requireSession(sessions), async (req, res) => {
        const devices = await loadDevices(devicesFile);
        res.json({ success: true, devices: devices.map(publicDevice) });
    });

    app.post('/api/logout', requireSession(sessions), (req, res) => {
        sessions.destroy(req.sessionToken);
        res.setHeader('Set-Cookie', createExpiredSessionCookie());
        res.json({ success: true });
    });

    return { app, sessions };
}

function createServer(options = {}) {
    const { app, sessions } = createApp(options);
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    const jobs = createJobStore(options);

    wss.on('connection', (ws, req) => {
        if (!isAllowedOrigin(req)) {
            closeUnauthorizedWebSocket(ws, 'Invalid origin', req);
            return;
        }

        const token = parseCookies(req.headers.cookie).wol_session;
        if (!sessions.isValid(token)) {
            closeUnauthorizedWebSocket(ws, token ? 'Invalid session' : 'Missing session cookie', req);
            return;
        }

        console.log('前端 WebSocket 已連線');
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'wakeup') {
                    jobs.create(String(data.deviceId || ''), ws);
                    return;
                }
                if (data.type === 'resume' && data.jobId) {
                    jobs.attach(String(data.jobId), ws);
                }
            } catch (error) {
                console.error('處理 WebSocket 訊息時出錯:', error);
                safeSend(ws, { type: 'log', message: '伺服器內部錯誤。' });
                safeSend(ws, { type: 'done', success: false });
            }
        });
        ws.on('close', () => {
            jobs.detach(ws);
            console.log('前端 WebSocket 已斷線');
        });
    });

    return server;
}

function loadConfig(configFile = CONFIG_FILE) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (!config.hashedPassword) {
        throw new Error('在 config.json 中找不到 hashedPassword');
    }
    return config;
}

function start() {
    try {
        const config = loadConfig();
        const server = createServer({ hashedPassword: config.hashedPassword });
        const port = Number(process.env.PORT || config.port || DEFAULT_PORT);
        server.listen(port, '0.0.0.0', () => {
            console.log(`WOL HTTP 伺服器正在 http://0.0.0.0:${port} 上運行`);
        });
    } catch (error) {
        console.error('致命錯誤：無法讀取或解析 config.json！', error);
        process.exit(1);
    }
}

if (require.main === module) {
    start();
}

module.exports = {
    createApp,
    createLoginRateLimiter,
    createServer,
    createSessionStore,
    isAllowedOrigin,
    isValidMac,
    loadDevices,
    normalizeDevices,
    sendMagicPacket
};
