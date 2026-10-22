// Everything that knows how to drive the Superprofile / Cashfree checkout page.
// The selectors and the workarounds below were each derived by observing the live
// site; the comments explain why they are shaped the way they are. Changing them
// on aesthetic grounds will break the flow in ways that only show up at runtime.
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

const config = require('../config');
const browserPool = require('./browser.pool');

// The checkout inputs carry no id/name, so anchor on the wrapper classes.
// The phone field's wrapper is .international-phone-input; the email one is not.
const EMAIL_INPUT = '.form-outline:not(.international-phone-input) > input.form-control';
const PHONE_INPUT = 'input[type="tel"].checkout-form-input-wrapper';
// Two "Get App Now" buttons exist; #payment_button_rzp is the visible one.
const GET_APP_NOW_BUTTON = '#payment_button_rzp';
const CHECKOUT_MODAL = '#cashfree-modal-container';
// The QR step happens inside Cashfree's own iframe, not the top-level document.
const UPI_FRAME_URL = /payment-method\/upi/;
const SHOW_QR_BUTTON = "//button[contains(., 'Click to see QR')]";
// Only the QR renders as an inline data URL; every other image is a remote logo.
const QR_IMAGE = 'img[src^="data:image/png;base64,"]';
// The red "Your payment could not be completed" banner shown after a failed
// attempt. When it appears the QR reverts to the "Click to see QR" button state.
const RETRY_BANNER = '.retry-container';
const RETRY_POLL_MS = 2000;

// Cashfree polls this endpoint with the live transaction state; transactionStatus
// sits at INCOMPLETE until the payer acts, then moves to a terminal value.
const RECONCILIATION_URL = /\/checkouts\/payments\/reconciliations\//;
const PAID_STATUSES = ['SUCCESS', 'PAID', 'COMPLETED'];
const FAILED_STATUSES = ['FAILED', 'CANCELLED', 'USER_DROPPED', 'VOID', 'FLAGGED'];

// The flow reads HTML, script and XHR and nothing else: every logo, web font and
// analytics beacon on the page is weight on the critical path. The QR is exempt
// by construction - it is a data: URL, and Chromium never routes those through
// request interception.
const SKIPPABLE_RESOURCES = new Set(['image', 'font', 'media']);
const TRACKER_HOSTS = /(google-analytics|googletagmanager|doubleclick|facebook\.net|connect\.facebook|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|fullstory|intercom|crisp\.chat|posthog)/i;

// Banner colours: black-on-green for good news, white-on-red for bad.
const GREEN = '\x1b[42m\x1b[30m';
const RED = '\x1b[41m\x1b[97m';

// Per-step stopwatch. generate-payment is a chain of waits on someone else's
// site, so when it is slow the only useful question is which wait - guessing
// from a single total has us tuning the wrong step.
function createTimer(label) {
    const start = Date.now();
    let last = start;
    const steps = [];

    return {
        mark(name) {
            const now = Date.now();
            steps.push(`${name} ${now - last}ms`);
            last = now;
        },
        report(what) {
            if (!config.logTimings) return;
            console.log(`${label}${what} in ${Date.now() - start}ms (${steps.join(', ')})`);
        }
    };
}

// Block of colour, so the value stands out in a noisy morgan-body log.
function logHighlighted(label, value, colour = GREEN) {
    const line = ` ${label}: ${value} `;
    console.log(`${colour}%s\x1b[0m`, ' '.repeat(line.length));
    console.log(`${colour}\x1b[1m%s\x1b[0m`, line);
    console.log(`${colour}%s\x1b[0m`, ' '.repeat(line.length));
}

// Poll for a child frame by URL; it attaches asynchronously after the modal
// opens. Polled tightly - the check is a synchronous array scan, so the interval
// is pure added latency.
async function waitForFrame(page, urlPattern, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const frame = page.frames().find(f => urlPattern.test(f.url()));
        if (frame) return frame;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
}

// jsQR wants raw RGBA, so the base64 PNG has to be unpacked first.
function decodeQrDataUrl(dataUrl) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const png = PNG.sync.read(Buffer.from(base64, 'base64'));
    const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    return result ? result.data : null;
}

// Reveal the QR and hand back its data URL. The button lands in the DOM before
// Svelte attaches its handler, so the first click is routinely swallowed - retry
// until the image actually renders. A real mouse click misses inside this nested
// cross-origin iframe, hence the in-page el.click().
//
// The retry interval is short on purpose. A swallowed click is only discovered
// when the wait times out, so a long interval is paid in full on the common
// path; a short one gets the second click in almost immediately. Once a click
// does land the button leaves the DOM, and the loop degrades into a poll for the
// image rather than clicking again.
async function revealQr(upiFrame) {
    await upiFrame.waitForXPath(SHOW_QR_BUTTON, { visible: true, timeout: 30000 });

    for (let attempt = 0; attempt < config.qr.clickAttempts; attempt++) {
        const [showQrButton] = await upiFrame.$x(SHOW_QR_BUTTON);
        if (showQrButton) await showQrButton.evaluate(el => el.click()).catch(() => { });

        const shown = await upiFrame
            .waitForSelector(QR_IMAGE, { visible: true, timeout: config.qr.clickRetryMs })
            .then(() => true)
            .catch(() => false);
        if (shown) return upiFrame.$eval(QR_IMAGE, img => img.src);
    }

    throw new Error('QR never rendered after clicking "Click to see QR"');
}

// "Expires in MM:SS" is plain text in the right-hand column; it vanishes at zero.
function readExpiry(upiFrame) {
    return upiFrame.evaluate(() => {
        const match = (document.body.innerText || '').match(/Expires in\s*(\d{1,2}:\d{2})/i);
        return match ? match[1] : null;
    });
}

// Hold the current QR until it is 90% through its life, reporting the page's own
// countdown as we go, then hand back so it can be replaced.
// `stop()` lets the caller end the wait early - Promise.race abandons the losing
// promise but does not stop it, so without this the countdown keeps logging after
// something else has already won the race.
async function waitUntilRefreshDue(upiFrame, label = 'refreshing QR in', stop = () => false) {
    const deadline = Date.now() + config.qr.refreshAfterMs;
    while (Date.now() < deadline && !stop()) {
        const left = deadline - Date.now();
        const onPage = await readExpiry(upiFrame).catch(() => null);
        console.log(`${label} ${Math.ceil(left / 1000)}s (page: expires in ${onPage ?? 'n/a'})`);

        // Sleep in short slices rather than one long one, so losing this race
        // stands the countdown down promptly instead of up to a full interval
        // later - otherwise a stale countdown prints after a retry or a success.
        const until = Date.now() + Math.min(config.qr.logIntervalMs, left);
        while (Date.now() < until && !stop()) {
            await new Promise(resolve =>
                setTimeout(resolve, Math.min(500, until - Date.now())));
        }
    }
}

function isRetryBannerVisible(upiFrame) {
    return upiFrame.evaluate(selector => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }, RETRY_BANNER);
}

// Poll every 2s and resolve on the RISING EDGE of the failure banner: visible
// now, not visible last time we looked. The edge check matters because the
// banner stays on screen after we react to it - without it we would mint a new
// QR every 2 seconds forever.
async function waitForRetryBanner(upiFrame, stop = () => false, state = {}) {
    while (!stop()) {
        const present = await isRetryBannerVisible(upiFrame).catch(() => false);

        if (!present) {
            state.bannerSeen = false;
        } else if (!state.bannerSeen) {
            state.bannerSeen = true;
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, RETRY_POLL_MS));
    }
    return false;
}

// Force a fresh QR before the old one lapses. There is no refresh control while a
// QR is on screen, but reloading Cashfree's iframe resets it to the "Click to see
// QR" state and mints a new transaction. Returns the replacement frame handle.
async function refreshQrFrame(page) {
    const current = page.frames().find(f => UPI_FRAME_URL.test(f.url()));
    // The reload tears down the execution context, so this call rejects by design.
    if (current) await current.evaluate(() => location.reload()).catch(() => { });

    const reloaded = await waitForFrame(page, UPI_FRAME_URL, 30000);
    if (!reloaded) throw new Error('UPI frame did not come back after reload');
    return reloaded;
}

// Watch the reconciliation poll for the payment being completed.
//
// Only SUCCESS is terminal. A failed attempt is reported through `onFailure` and
// deliberately does not settle the promise: the payer can retry on a fresh QR,
// so the session has to survive it.
//
// `onTransactionId` fires as soon as an id is seen, even while still pending.
// `onActivity` fires only when the status actually CHANGES - the poll itself
// repeats every ~3s and must not be mistaken for the payer doing something.
function watchPayment(page, { label = '', onTransactionId, onActivity, onFailure } = {}) {
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    let lastStatus = null;
    let reportedId = null;

    page.on('response', async response => {
        if (!RECONCILIATION_URL.test(response.url())) return;

        let body;
        try {
            body = await response.json();
        } catch (_) {
            return; // non-JSON or body already gone
        }

        if (body.transactionId && body.transactionId !== reportedId) {
            reportedId = body.transactionId;
            onTransactionId?.(String(body.transactionId));
        }

        const status = String(body.transactionStatus || '').toUpperCase();
        if (!status || status === lastStatus) return; // the poll repeats every ~3s
        lastStatus = status;
        onActivity?.(status); // a real transition: the payer moved

        const txn = `txn ${body.transactionId}, Rs ${body.transactionAmount} via ${body.paymentMode}`;
        if (PAID_STATUSES.includes(status)) {
            logHighlighted('PAYMENT RECEIVED', `${label}${txn}`, GREEN);
            settle({ paid: true, status, transactionId: String(body.transactionId) });
        } else if (FAILED_STATUSES.includes(status)) {
            const why = body.transactionMessage ? ` - ${body.transactionMessage}` : '';
            logHighlighted('PAYMENT FAILED', `${label}${txn} - ${status}${why}`, RED);
            // Not terminal: the retry banner watcher will issue a fresh QR.
            onFailure?.({ status, transactionId: String(body.transactionId) });
        } else {
            console.log(`${label}payment pending (${status})`);
        }
    });

    return settled;
}

// Drop the requests the flow never looks at. Anything not matched is passed
// through untouched, so a page change can only cost us speed, never correctness.
async function blockDecorativeRequests(page) {
    await page.setRequestInterception(true);

    page.on('request', request => {
        const skip = SKIPPABLE_RESOURCES.has(request.resourceType())
            || TRACKER_HOSTS.test(request.url());
        // Both calls reject if the request was already handled or the frame is
        // gone; neither is worth reporting.
        (skip ? request.abort() : request.continue()).catch(() => { });
    });
}

// A context loaded and parked on the empty checkout form - everything that can
// be done before an identity is known.
async function preparePage() {
    const { context, page } = await browserPool.createSessionContext();

    try {
        if (config.checkout.blockAssets) await blockDecorativeRequests(page);

        await page.goto(config.checkout.paymentPageURL, {
            waitUntil: config.checkout.navWaitUntil,
            timeout: 60000
        });

        // The checkout is client-rendered, so the fields are the readiness
        // signal, not the navigation. They appear together; waiting on them in
        // sequence just serialises two waits for the same moment.
        await Promise.all([
            page.waitForSelector(EMAIL_INPUT, { visible: true, timeout: 30000 }),
            page.waitForSelector(PHONE_INPUT, { visible: true, timeout: 30000 })
        ]);

        return { context, page, preparedAt: Date.now() };
    } catch (error) {
        await browserPool.closeContext(context);
        throw error;
    }
}

// Pages prepared ahead of demand. Loading the checkout is the single longest
// step and needs nothing from the request, so it is done off the critical path
// and a request collects the result.
//
// Kept only while requests are actually arriving. A pool that refills on a timer
// regardless of demand re-loads someone else's checkout every few minutes
// forever, which is both rude and the sort of steady background traffic that
// gets an IP rate-limited. Idle here means idle: the pool drains to nothing and
// the next request pays a cold load to bring it back.
const warmPages = [];
let warmPending = 0;
let refillTimer = null;
let sweepTimer = null;
let lastDemandAt = 0;

function poolWanted() {
    return config.checkout.warmPoolSize > 0
        && Date.now() - lastDemandAt < config.checkout.warmIdleAfterMs;
}

function discardWarmPages(reason) {
    const dropped = warmPages.splice(0);
    if (dropped.length) console.log(`Discarding ${dropped.length} warm page(s): ${reason}`);
    dropped.forEach(entry => browserPool.closeContext(entry.context).catch(() => { }));
}

// Oldest first, so a page is used while it still has life in it.
function takeWarmPage() {
    while (warmPages.length) {
        const entry = warmPages.shift();
        const stale = Date.now() - entry.preparedAt > config.checkout.warmPageMaxAgeMs;
        if (!stale && !entry.page.isClosed()) return entry;
        browserPool.closeContext(entry.context).catch(() => { });
    }
    return null;
}

function fillWarmPool() {
    while (poolWanted() && warmPages.length + warmPending < config.checkout.warmPoolSize) {
        warmPending++;
        preparePage()
            .then(entry => {
                // Shutdown or a lost browser while this was loading; parking it
                // now would leak a context nobody will ever close.
                if (!sweepTimer) return browserPool.closeContext(entry.context);
                warmPages.push(entry);
            })
            .catch(error => console.error('Warm page failed to prepare:', error.message))
            .finally(() => { warmPending--; });
    }
}

// Deferred, because the request that just took a page is still mid-flight and a
// second page load would compete with it for the same CPU and bandwidth.
function scheduleRefill() {
    if (refillTimer || !sweepTimer) return;
    refillTimer = setTimeout(() => {
        refillTimer = null;
        fillWarmPool();
    }, config.checkout.warmRefillDelayMs);
    refillTimer.unref?.();
}

// Parked pages age out whether or not anyone takes them, so they are swept on a
// timer. Replacing them is conditional on recent demand - while nothing is being
// asked for, the sweep only throws away and the pool empties itself.
function startWarmPool() {
    if (!config.checkout.warmPoolSize || sweepTimer) return;

    sweepTimer = setInterval(() => {
        const fresh = warmPages.filter(entry => {
            const usable = Date.now() - entry.preparedAt <= config.checkout.warmPageMaxAgeMs
                && !entry.page.isClosed();
            if (!usable) browserPool.closeContext(entry.context).catch(() => { });
            return usable;
        });
        warmPages.splice(0, warmPages.length, ...fresh);
        fillWarmPool();
    }, config.checkout.warmSweepMs);
    sweepTimer.unref?.();

    // One page is prepared at startup so the first caller after a deploy is not
    // the one who pays for it. If that request never comes, the pool drains.
    lastDemandAt = Date.now();

    // The whole browser dying takes every parked context with it. Handlers are
    // dropped once they fire, so the watch is re-armed for the replacement
    // browser the next refill will launch.
    const watchBrowser = () => browserPool.onBrowserLost(() => {
        discardWarmPages('browser was lost');
        if (sweepTimer) watchBrowser();
    });
    watchBrowser();

    fillWarmPool();
    console.log(`Warm checkout pool: ${config.checkout.warmPoolSize} page(s)`);
}

function stopWarmPool() {
    if (refillTimer) clearTimeout(refillTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    refillTimer = null;
    sweepTimer = null;
    discardWarmPages('shutting down');
}

// Drive the page from a loaded form to the point where a QR can be revealed:
// fill in the supplied identity, open the Cashfree modal, and hand back the UPI
// frame.
async function openCheckout({ label = '', email, phone, onTransactionId, onActivity, onFailure } = {}) {
    if (!email || !phone) throw new Error('openCheckout requires an email and phone');

    const timer = createTimer(label);
    lastDemandAt = Date.now(); // keeps the pool alive while traffic continues

    // A page that has been parked for a while may have gone stale on the site's
    // side, and that failure would otherwise surface as a failed request. One
    // cold retry costs the load time we were trying to save and no more, so the
    // pool can only ever make a request faster, never break it.
    const warm = takeWarmPage();
    // Replace what was taken, or top the pool up after a cold start.
    scheduleRefill();

    if (warm) {
        timer.mark('warm page');
        try {
            return await driveToUpiFrame(warm, timer,
                { label, email, phone, onTransactionId, onActivity, onFailure });
        } catch (error) {
            console.warn(`${label}warm page failed (${error.message}) - retrying on a fresh one`);
        }
    }

    const cold = await preparePage();
    timer.mark('cold page load');
    return driveToUpiFrame(cold, timer,
        { label, email, phone, onTransactionId, onActivity, onFailure });
}

// Typing through the CDP keyboard costs a network round trip per character -
// around 600ms for an email plus a phone number. Input.insertText delivers the
// whole string in one, and still raises a trusted `input` event, which is what
// the page's bindings actually read; the last character is typed for real so
// anything listening for a keystroke still gets one.
//
// A masked or otherwise fussy field could still refuse the bulk insert, so the
// value is read back and a field that did not take it is refilled the slow way.
async function fillField(page, selector, value, matches) {
    if (config.checkout.fastTyping && value.length > 1) {
        await page.click(selector);
        await page.keyboard.sendCharacter(value.slice(0, -1));
        await page.type(selector, value.slice(-1), { delay: config.checkout.typeDelayMs });

        const filled = await page.$eval(selector, el => el.value).catch(() => null);
        if (filled !== null && matches(filled, value)) return;

        console.warn(`Bulk fill did not take on ${selector} - typing it out`);
        // Cleared through the UI rather than by assigning value, so the page's
        // own bindings see the field empty too.
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
    }

    await page.type(selector, value, { delay: config.checkout.typeDelayMs });
}

const exactly = (filled, value) => filled === value;
// The widget reformats what it is given (spacing, +91), so only the digits of
// the number itself are meaningful.
const sameDigits = (filled, value) => filled.replace(/\D/g, '').endsWith(value);

// Form -> modal -> UPI frame, on an already-loaded page.
async function driveToUpiFrame({ context, page }, timer, options) {
    const { label, email, phone, onTransactionId, onActivity, onFailure } = options;

    try {
        // Attached before the button is clicked, which is what starts the
        // reconciliation polling, so no poll is missed.
        const paymentSettled = watchPayment(page, { label, onTransactionId, onActivity, onFailure });

        await fillField(page, EMAIL_INPUT, email, exactly);
        // Country code +91 is already pinned by the widget - only the digits go in.
        await fillField(page, PHONE_INPUT, phone, sameDigits);
        timer.mark('form filled');

        await page.waitForSelector(GET_APP_NOW_BUTTON, { visible: true, timeout: 30000 });
        await page.click(GET_APP_NOW_BUTTON);

        // Clicking hands off to the Cashfree checkout modal (despite the button
        // being id'd payment_button_rzp), which mounts as a fixed overlay.
        await page.waitForSelector(CHECKOUT_MODAL, { visible: true, timeout: 30000 });
        timer.mark('modal');

        const upiFrame = await waitForFrame(page, UPI_FRAME_URL, 30000);
        if (!upiFrame) throw new Error('Cashfree UPI frame never appeared');
        timer.mark('upi frame');

        timer.report('checkout ready');
        return { context, page, upiFrame, paymentSettled };
    } catch (error) {
        // Drop the context, not the shared browser - other sessions are using it.
        await browserPool.closeContext(context);
        throw error;
    }
}

module.exports = {
    openCheckout,
    startWarmPool,
    stopWarmPool,
    createTimer,
    revealQr,
    decodeQrDataUrl,
    refreshQrFrame,
    waitUntilRefreshDue,
    waitForRetryBanner,
    isRetryBannerVisible,
    logHighlighted,
    GREEN,
    RED
};
