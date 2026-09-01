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

// Banner colours: black-on-green for good news, white-on-red for bad.
const GREEN = '\x1b[42m\x1b[30m';
const RED = '\x1b[41m\x1b[97m';

// Block of colour, so the value stands out in a noisy morgan-body log.
function logHighlighted(label, value, colour = GREEN) {
    const line = ` ${label}: ${value} `;
    console.log(`${colour}%s\x1b[0m`, ' '.repeat(line.length));
    console.log(`${colour}\x1b[1m%s\x1b[0m`, line);
    console.log(`${colour}%s\x1b[0m`, ' '.repeat(line.length));
}

// Poll for a child frame by URL; it attaches asynchronously after the modal opens.
async function waitForFrame(page, urlPattern, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const frame = page.frames().find(f => urlPattern.test(f.url()));
        if (frame) return frame;
        await new Promise(resolve => setTimeout(resolve, 250));
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
async function revealQr(upiFrame) {
    await upiFrame.waitForXPath(SHOW_QR_BUTTON, { visible: true, timeout: 30000 });

    let shown = false;
    for (let attempt = 0; attempt < config.qr.clickAttempts && !shown; attempt++) {
        const [showQrButton] = await upiFrame.$x(SHOW_QR_BUTTON);
        if (showQrButton) await showQrButton.evaluate(el => el.click());
        shown = await upiFrame
            .waitForSelector(QR_IMAGE, { visible: true, timeout: 3000 })
            .then(() => true)
            .catch(() => false);
    }
    if (!shown) throw new Error('QR never rendered after clicking "Click to see QR"');

    return upiFrame.$eval(QR_IMAGE, img => img.src);
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

// Drive the page from a cold load to the point where a QR can be revealed:
// fill the form with the supplied identity, open the Cashfree modal, and hand
// back the UPI frame.
async function openCheckout({ label = '', email, phone, onTransactionId, onActivity, onFailure } = {}) {
    if (!email || !phone) throw new Error('openCheckout requires an email and phone');

    // An isolated incognito context, not a whole browser - see browser.pool.js.
    const { context, page } = await browserPool.createSessionContext();

    try {
        // Attach before navigating so no reconciliation poll is missed.
        const paymentSettled = watchPayment(page, { label, onTransactionId, onActivity, onFailure });

        await page.goto(config.checkout.paymentPageURL, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // The checkout is client-rendered, so wait for the fields themselves.
        await page.waitForSelector(EMAIL_INPUT, { visible: true, timeout: 30000 });
        await page.waitForSelector(PHONE_INPUT, { visible: true, timeout: 30000 });

        // type() fires real key events, which the page's framework needs in order
        // to register the value.
        await page.type(EMAIL_INPUT, email, { delay: 50 });
        // Country code +91 is already pinned by the widget - only the digits go in.
        await page.type(PHONE_INPUT, phone, { delay: 50 });

        await page.waitForSelector(GET_APP_NOW_BUTTON, { visible: true, timeout: 30000 });
        await page.click(GET_APP_NOW_BUTTON);

        // Clicking hands off to the Cashfree checkout modal (despite the button
        // being id'd payment_button_rzp), which mounts as a fixed overlay.
        await page.waitForSelector(CHECKOUT_MODAL, { visible: true, timeout: 30000 });

        const upiFrame = await waitForFrame(page, UPI_FRAME_URL, 30000);
        if (!upiFrame) throw new Error('Cashfree UPI frame never appeared');

        return { context, page, upiFrame, paymentSettled };
    } catch (error) {
        // Drop the context, not the shared browser - other sessions are using it.
        await browserPool.closeContext(context);
        throw error;
    }
}

module.exports = {
    openCheckout,
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
