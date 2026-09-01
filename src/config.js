// Every environment read and tunable lives here, so nothing else has to guess.
// .env is loaded by Node itself via --env-file-if-exists in the npm scripts,
// so there is no dotenv dependency.

const bool = (value, fallback) => {
    if (value === undefined) return fallback;
    return String(value).toLowerCase() === 'true';
};

const int = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

// Each QR is good for 5 minutes. Refresh at 90% of that so a new one is always
// in hand before the old lapses, rather than racing the expiry.
const QR_TTL_MS = int(process.env.QR_TTL_MS, 5 * 60 * 1000);
const QR_REFRESH_BUFFER = 0.10;

module.exports = {
    port: int(process.env.PORT, 8080),
    mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/paymentize',

    // Visible windows are useful when debugging one run, unusable at concurrency.
    headless: bool(process.env.HEADLESS, true),

    // Sessions are incognito contexts in one shared Chromium (~100-150MB each),
    // not separate browsers. Still capped so a burst cannot exhaust memory.
    maxSessions: int(process.env.MAX_SESSIONS, 25),

    // Close a session that has seen no activity for this long, and fail it.
    idleTimeoutMs: int(process.env.IDLE_TIMEOUT_MS, 20 * 60 * 1000),

    qr: {
        ttlMs: QR_TTL_MS,
        refreshAfterMs: QR_TTL_MS * (1 - QR_REFRESH_BUFFER), // 4m30s at defaults
        clickAttempts: 10,
        logIntervalMs: int(process.env.QR_LOG_INTERVAL_MS, 30000)
    },

    checkout: {
        paymentPageURL: process.env.PAYMENT_PAGE_URL
            || 'https://superprofile.bio/vp/parent-control-app-'
        // The email/phone typed into the form are drawn per request from
        // static/emails.json and static/numbers.json - see identity.service.js.
    }
};
