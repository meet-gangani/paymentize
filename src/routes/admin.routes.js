const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const sessions = require('../services/session.manager');
const { Payment, STATUS } = require('../models/payment.model');

const router = express.Router();

// One token per process, handed out as a cookie on a correct password. A restart
// mints a new one, so every open panel gets a 401 and asks for the password again.
const AUTH_COOKIE = 'admin_auth';
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

function isAuthed(req) {
    return (req.headers.cookie || '')
        .split(';')
        .some(pair => pair.trim() === `${AUTH_COOKIE}=${AUTH_TOKEN}`);
}

function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'Password required' });
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const LIST_FIELDS = {
    paymentId: 1, deviceId: 1, manufacturer: 1, modelNo: 1,
    email: 1, phone: 1, status: 1, qrValue: 1, expireAt: 1,
    message: 1, transactionId: 1, createdAt: 1,
    failedAttempts: 1, lastFailureAt: 1
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// The page itself carries no data, so it always renders - locked behind the
// password popup unless the cookie is already valid.
router.get('/', (req, res) => {
    res.render('admin', { title: 'Paymentize Admin', authed: isAuthed(req) });
});

router.post('/login', (req, res) => {
    if (String(req.body?.password ?? '') !== config.adminPassword) {
        return res.status(401).json({ error: 'Wrong password' });
    }
    res.cookie(AUTH_COOKIE, AUTH_TOKEN, { path: '/admin', httpOnly: true, sameSite: 'strict' });
    res.status(200).json({ ok: true });
});

// Polled by public/js/admin.js every couple of seconds.
// ?page=1&limit=20 - newest first.
router.get('/stats.json', requireAuth, async (req, res) => {
    try {
        // A non-positive limit is junk, not a request for one row per page.
        const rawLimit = parseInt(req.query.limit, 10);
        const limit = clamp(rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
        const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);

        // Counted first so a page beyond the end can be clamped rather than
        // returning an empty table - deleting rows would otherwise strand the UI.
        const total = await Payment.countDocuments({});
        const totalPages = Math.max(Math.ceil(total / limit), 1);
        const page = Math.min(requestedPage, totalPages);

        const [successCount, failedCount, pendingCount, payments] = await Promise.all([
            Payment.countDocuments({ status: STATUS.SUCCESS }),
            Payment.countDocuments({ status: STATUS.FAILED }),
            Payment.countDocuments({ status: STATUS.PENDING }),
            Payment.find({}, LIST_FIELDS)
                .sort({ createdAt: -1 })     // newest first
                .skip((page - 1) * limit)
                .limit(limit)
                .lean()
        ]);

        res.status(200).json({
            // Live from memory - the only honest source for what is actually running.
            openBrowsers: sessions.count(),
            successCount,
            failedCount,
            pendingCount,
            payments,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                from: total === 0 ? 0 : (page - 1) * limit + 1,
                to: Math.min(page * limit, total)
            }
        });
    } catch (error) {
        console.error('admin stats failed:', error.message);
        res.status(500).json({ error: 'Could not load stats' });
    }
});

module.exports = router;
