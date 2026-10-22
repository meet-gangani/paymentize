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

    // Asked for by the /admin popup before any stats are served.
    adminPassword: process.env.ADMIN_PASSWORD || '7227',

    // Visible windows are useful when debugging one run, unusable at concurrency.
    headless: bool(process.env.HEADLESS, true),

    // Sessions are incognito contexts in one shared Chromium, not separate
    // browsers - but a live one holds the Cashfree modal and its nested iframe
    // open, which measures at ~300MB, not the ~110MB a parked context costs.
    // Budget 300MB each: 25 is about 7.5GB before the OS gets a look in.
    maxSessions: int(process.env.MAX_SESSIONS, 25),

    // Close a session that has seen no activity for this long, and fail it.
    idleTimeoutMs: int(process.env.IDLE_TIMEOUT_MS, 20 * 60 * 1000),

    // Per-step timings for generate-payment. Cheap, and the only way to tell a
    // slow network from a slow page from a swallowed click.
    logTimings: bool(process.env.LOG_TIMINGS, true),

    qr: {
        ttlMs: QR_TTL_MS,
        refreshAfterMs: QR_TTL_MS * (1 - QR_REFRESH_BUFFER), // 4m30s at defaults
        // The first click on "Click to see QR" is routinely swallowed, so the
        // reveal is a click-then-check loop. Checking often costs nothing and
        // gets the retry in quickly; the attempt budget keeps the overall wait
        // near 16s for the case where the QR genuinely never renders.
        clickAttempts: int(process.env.QR_CLICK_ATTEMPTS, 40),
        clickRetryMs: int(process.env.QR_CLICK_RETRY_MS, 400),
        logIntervalMs: int(process.env.QR_LOG_INTERVAL_MS, 30000)
    },

    checkout: {
        paymentPageURL: process.env.PAYMENT_PAGE_URL
            || 'https://superprofile.bio/vp/parent-control-app-',
        // The email/phone typed into the form are drawn per request from
        // static/emails.json and static/numbers.json - see identity.service.js.

        // 'networkidle2' waits for the page's analytics and pixel chatter to go
        // quiet, which happens seconds after the form is actually usable. The
        // selector waits are the real readiness signal, so the navigation itself
        // only has to get as far as the DOM.
        navWaitUntil: process.env.NAV_WAIT_UNTIL || 'domcontentloaded',

        // Images, fonts, media and third-party trackers are never read by the
        // flow, and the QR arrives as a data: URL which Chromium never routes
        // through interception. Set BLOCK_ASSETS=false if the page ever starts
        // depending on one of them.
        blockAssets: bool(process.env.BLOCK_ASSETS, true),

        // type() still fires real key events at 0ms, which is all the page's
        // framework needs; the old 50ms was ~1.7s of pure delay per request.
        typeDelayMs: int(process.env.TYPE_DELAY_MS, 0),

        // Deliver the form values in one insert instead of a round trip per
        // character. Self-checking - a field that rejects it is retyped - so
        // this only needs turning off to rule it out.
        fastTyping: bool(process.env.FAST_TYPING, true),

        // Pages kept loaded and parked on the empty form, so a request starts at
        // "type the identity" instead of "fetch the page". Each one costs a
        // context (~100-150MB), so the default keeps exactly one in hand.
        warmPoolSize: int(process.env.WARM_POOL_SIZE, 1),
        // A parked page is only useful while the site still considers it fresh.
        warmPageMaxAgeMs: int(process.env.WARM_PAGE_MAX_AGE_MS, 4 * 60 * 1000),
        // Refill after the request that took the page is past its slow part, so
        // the replacement load never competes with the one in flight.
        warmRefillDelayMs: int(process.env.WARM_REFILL_DELAY_MS, 5000),
        warmSweepMs: int(process.env.WARM_SWEEP_MS, 60000),
        // Stop pre-loading once requests stop. Without this the pool re-loads
        // the checkout every few minutes around the clock, whether or not anyone
        // wants a QR - background traffic that earns an IP a rate limit.
        warmIdleAfterMs: int(process.env.WARM_IDLE_AFTER_MS, 10 * 60 * 1000)
    }
};
