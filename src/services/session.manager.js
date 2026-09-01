// Owns the live Chromium instances. The database is the source of truth for
// payment data; this Map is the source of truth for what is actually running.
const config = require('../config');
const browserPool = require('./browser.pool');
const { Payment, STATUS } = require('../models/payment.model');

const sessions = new Map(); // paymentId -> { browser, page, idleTimer, cancel }

function count() {
    return sessions.size;
}

function get(paymentId) {
    return sessions.get(paymentId);
}

function add(paymentId, session) {
    sessions.set(paymentId, { ...session, idleTimer: null });
    touch(paymentId);
}

// Re-arm this session's idle timer. Each session carries its own timer, so a
// session timing out never affects any other browser.
function touch(paymentId) {
    const session = sessions.get(paymentId);
    if (!session) return;

    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        const minutes = Math.round(config.idleTimeoutMs / 60000);
        console.log(`[${paymentId}] idle for ${minutes} min - closing browser`);
        close(paymentId, {
            status: STATUS.FAILED,
            message: `No activity for ${minutes} minutes - session closed automatically`
        }).catch(error => console.error(`[${paymentId}] idle close failed:`, error.message));
    }, config.idleTimeoutMs);

    // Best effort: keep the persisted heartbeat roughly in step with the timer.
    Payment.updateOne({ paymentId }, { $set: { lastActivityAt: new Date() } })
        .catch(() => { });
}

// Tear a session down and record the outcome. Safe to call for a paymentId that
// has no live session (e.g. finalizing something already closed).
async function close(paymentId, { status, message, transactionId } = {}) {
    const session = sessions.get(paymentId);

    if (session) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.cancel) session.cancel.cancelled = true; // stop the QR loop
        sessions.delete(paymentId);
        // Closes this session's incognito context only - the shared Chromium
        // stays up for the other sessions.
        await browserPool.closeContext(session.context);
    }

    const update = { browserOpen: false };
    if (status) {
        update.status = status;
        update.finalizedAt = new Date();
    }
    if (message !== undefined) update.message = message;
    if (transactionId) update.transactionId = transactionId;

    return Payment.findOneAndUpdate({ paymentId }, { $set: update }, { returnDocument: 'after' });
}

// Close everything, for graceful shutdown, then drop the shared Chromium itself.
async function closeAll(message) {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map(id =>
        close(id, { status: STATUS.FAILED, message }).catch(() => { })));
    await browserPool.shutdown();
    return ids.length;
}

module.exports = { add, get, touch, close, closeAll, count };
