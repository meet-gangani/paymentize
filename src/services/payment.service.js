const crypto = require('crypto');

const config = require('../config');
const checkout = require('./checkout.service');
const identities = require('./identity.service');
const browserPool = require('./browser.pool');
const sessions = require('./session.manager');
const { Payment, STATUS } = require('../models/payment.model');

class TooManySessionsError extends Error {
    constructor(limit) {
        super(`Session limit reached (${limit} browsers already open)`);
        this.name = 'TooManySessionsError';
    }
}

// Persist a newly revealed QR.
//
// Deliberately does NOT touch the idle timer. Regeneration is our own automation
// running every 4m30s; if it counted as activity the 20 minute idle timeout could
// never elapse and no session would ever close on its own. Only outside activity
// - a client polling get-payment-status, or the payer moving the transaction on
// - counts as movement.
async function recordQr(paymentId, qrValue) {
    const generatedAt = new Date();
    const expireAt = new Date(generatedAt.getTime() + config.qr.ttlMs);

    await Payment.updateOne({ paymentId }, {
        $set: { qrValue, expireAt },
        $push: { qrHistory: { qrValue, generatedAt, expireAt } }
    });

    return { qrValue, expireAt };
}

// Open a browser, walk the checkout to a first decoded QR, and leave the session
// running in the background. Resolves as soon as that first QR exists.
async function generatePayment({ deviceId, manufacturer, modelNo }) {
    if (sessions.count() >= config.maxSessions) {
        throw new TooManySessionsError(config.maxSessions);
    }

    const paymentId = crypto.randomUUID();
    const label = `[${paymentId.slice(0, 8)}] `;
    // Drawn per call from static/emails.json and static/numbers.json.
    const { email, phone } = identities.pickIdentity();
    console.log(`${label}using ${email} / ${phone}`);

    await Payment.create({
        paymentId,
        deviceId,
        manufacturer,
        modelNo,
        email,
        phone,
        status: STATUS.PENDING,
        lastActivityAt: new Date()
    });

    let opened;
    try {
        opened = await checkout.openCheckout({
            label,
            email,
            phone,
            onTransactionId: transactionId =>
                Payment.updateOne({ paymentId }, { $set: { transactionId } }).catch(() => { }),
            // A genuine status transition means the payer acted - that is movement.
            onActivity: () => sessions.touch(paymentId),
            // Reported for visibility only; the retry banner drives the recovery.
            onFailure: ({ status }) =>
                console.log(`${label}attempt failed (${status}) - waiting for retry banner`)
        });
    } catch (error) {
        await Payment.updateOne({ paymentId }, {
            $set: {
                status: STATUS.FAILED,
                browserOpen: false,
                message: `Checkout failed to open: ${error.message}`,
                finalizedAt: new Date()
            }
        });
        throw error;
    }

    const { context, page, upiFrame, paymentSettled } = opened;

    const cancel = {};
    sessions.add(paymentId, { context, page, cancel });
    await Payment.updateOne({ paymentId }, { $set: { browserOpen: true } });

    // A tab closed by hand would otherwise leave a phantom entry in the session
    // map, so the admin count would never come down. sessions.close() removes the
    // entry BEFORE closing the context, so if the session is already gone by the
    // time this fires, the close was our own teardown and there is nothing to do.
    const cleanUp = reason => {
        if (!sessions.get(paymentId)) return;
        console.log(`${label}${reason} - closing session`);
        cancel.cancelled = true;
        sessions.close(paymentId, { status: STATUS.FAILED, message: reason })
            .catch(error => console.error(`${label}cleanup failed:`, error.message));
    };

    page.once('close', () => cleanUp('Browser tab was closed manually'));
    // The shared Chromium dying takes every session with it, not just this one.
    const stopWatchingBrowser = browserPool.onBrowserLost(() => cleanUp('Browser was closed'));
    page.once('close', stopWatchingBrowser);

    // First QR, awaited so the caller has something to return. If this fails the
    // session is already registered, so it has to be torn down explicitly.
    let first;
    try {
        const qrValue = checkout.decodeQrDataUrl(await checkout.revealQr(upiFrame));
        if (!qrValue) throw new Error('QR image found but could not be decoded');
        checkout.logHighlighted(`${label}QR VALUE`, qrValue);
        first = await recordQr(paymentId, qrValue);
    } catch (error) {
        await sessions.close(paymentId, {
            status: STATUS.FAILED,
            message: `First QR failed: ${error.message}`
        }).catch(() => { });
        throw error;
    }

    // Everything after this point runs in the background; the browser stays open.
    runQrLoop({ paymentId, label, page, upiFrame, paymentSettled, cancel })
        .catch(error => console.error(`${label}QR loop crashed:`, error.message));

    return { paymentId, qrValue: first.qrValue, expireAt: first.expireAt };
}

// Keep a live QR in front of the payer until the payment succeeds, the session is
// finalized, or the idle timer closes it.
//
// Three things can end a wait, and they race:
//   - the QR reaching 90% of its life  -> reload the frame, mint a fresh QR
//   - the failure banner appearing     -> mint a fresh QR so the payer can retry
//   - the payment succeeding           -> close the session
// A failed attempt is NOT terminal; only success is.
async function runQrLoop({ paymentId, label, page, upiFrame, paymentSettled, cancel }) {
    let frame = upiFrame;
    // Shared across iterations so the banner's rising edge is tracked correctly.
    const bannerState = { bannerSeen: false };

    try {
        while (!cancel.cancelled) {
            // Per-iteration stop flag: whichever waiter loses the race must be
            // told to stand down, or it keeps polling in the background.
            const tick = { done: false };
            const stop = () => cancel.cancelled || tick.done;

            let outcome;
            try {
                outcome = await Promise.race([
                    checkout.waitUntilRefreshDue(frame, `${label}refreshing QR in`, stop)
                        .then(() => 'expiring'),
                    checkout.waitForRetryBanner(frame, stop, bannerState)
                        .then(found => (found ? 'retry' : 'stopped')),
                    paymentSettled.then(settled => ({ settled }))
                ]);
            } finally {
                tick.done = true;
            }

            // Finalize, idle timeout or a manual browser close got here first.
            if (cancel.cancelled) return;

            if (outcome?.settled) {
                const { settled } = outcome;
                await sessions.close(paymentId, {
                    status: STATUS.SUCCESS,
                    message: `Payment received (${settled.status})`,
                    transactionId: settled.transactionId
                });
                return;
            }

            if (outcome === 'retry') {
                // A failed attempt is the payer doing something, so it counts as
                // activity against the idle timer.
                sessions.touch(paymentId);
                await Payment.updateOne({ paymentId }, {
                    $inc: { failedAttempts: 1 },
                    $set: { lastFailureAt: new Date() }
                }).catch(() => { });

                checkout.logHighlighted(
                    `${label}PAYMENT ATTEMPT FAILED`, 'issuing a fresh QR to retry', checkout.RED);
                // The banner leaves the button on screen, so no frame reload is
                // needed - revealing again is enough to mint a new transaction.
            } else {
                console.log(`${label}QR refresh due - regenerating ahead of expiry`);
                frame = await checkout.refreshQrFrame(page);
            }

            const qrValue = checkout.decodeQrDataUrl(await checkout.revealQr(frame));
            if (!qrValue) throw new Error('QR image found but could not be decoded');
            checkout.logHighlighted(
                `${label}QR VALUE (${outcome === 'retry' ? 'after failed attempt' : 'regenerated'})`,
                qrValue);
            await recordQr(paymentId, qrValue);
        }
    } catch (error) {
        if (cancel.cancelled) return; // the teardown caused this, not a real fault
        console.error(`${label}session error:`, error.message);
        await sessions.close(paymentId, {
            status: STATUS.FAILED,
            message: `Session error: ${error.message}`
        }).catch(() => { });
    }
}

// Current QR for a payment. Touching the session resets its idle clock.
async function getPaymentStatus(paymentId) {
    const payment = await Payment.findOne({ paymentId });
    if (!payment) return null;

    sessions.touch(paymentId);

    return {
        paymentId: payment.paymentId,
        qrValue: payment.qrValue ?? null,
        expireAt: payment.expireAt ?? null,
        status: payment.status
    };
}

// Explicit finalize from the client. Idempotent: an already-final payment is
// returned untouched rather than being overwritten.
async function finalizePayment({ paymentId, status, message }) {
    const existing = await Payment.findOne({ paymentId });
    if (!existing) return null;

    if (existing.status !== STATUS.PENDING) {
        return { payment: existing, alreadyFinal: true };
    }

    const payment = await sessions.close(paymentId, { status, message });
    return { payment, alreadyFinal: false };
}

module.exports = {
    generatePayment,
    getPaymentStatus,
    finalizePayment,
    TooManySessionsError
};
