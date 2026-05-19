const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createLoginRateLimiter,
    createSessionStore,
    isAllowedOrigin,
    normalizeDevices,
    sendMagicPacket
} = require('../server');

test('normalizeDevices keeps only valid devices and assigns stable string ids', () => {
    const devices = normalizeDevices([
        { name: 'Desktop', mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.1.10' },
        { name: 'Bad MAC', mac: 'AA:BB:CC:DD:EE:FF; touch /tmp/pwned', ip: '192.168.1.11' },
        { name: 'Bad IP', mac: '11:22:33:44:55:66', ip: 'not-an-ip' }
    ]);

    assert.deepEqual(devices, [
        { id: '0', name: 'Desktop', mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.1.10' }
    ]);
});

test('sendMagicPacket rejects invalid MAC values before spawning wakeonlan', async () => {
    let called = false;

    await assert.rejects(
        () => sendMagicPacket('AA:BB:CC:DD:EE:FF; touch /tmp/pwned', () => {
            called = true;
        }),
        /Invalid MAC address/
    );

    assert.equal(called, false);
});

test('sendMagicPacket executes wakeonlan without shell interpolation', async () => {
    let captured;

    await sendMagicPacket('AA:BB:CC:DD:EE:FF', (command, args, callback) => {
        captured = { command, args };
        callback(null, 'sent', '');
    });

    assert.deepEqual(captured, {
        command: 'wakeonlan',
        args: ['AA:BB:CC:DD:EE:FF']
    });
});

test('session store issues expiring opaque tokens', () => {
    let now = 1000;
    const sessions = createSessionStore({ ttlMs: 100, now: () => now });
    const token = sessions.create();

    assert.equal(typeof token, 'string');
    assert.equal(sessions.isValid(token), true);

    now = 1200;
    assert.equal(sessions.isValid(token), false);
});

test('login rate limiter blocks repeated failed attempts and resets on success', () => {
    let now = 1000;
    const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 1000, now: () => now });

    assert.equal(limiter.isBlocked('1.2.3.4'), false);
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    assert.equal(limiter.isBlocked('1.2.3.4'), true);

    limiter.recordSuccess('1.2.3.4');
    assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('isAllowedOrigin rejects cross-origin WebSocket requests', () => {
    assert.equal(isAllowedOrigin({
        headers: {
            host: 'wol.example.com',
            origin: 'https://evil.example.net'
        }
    }), false);

    assert.equal(isAllowedOrigin({
        headers: {
            host: 'wol.example.com',
            origin: 'https://wol.example.com'
        }
    }), true);
});
