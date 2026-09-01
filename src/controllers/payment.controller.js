const paymentService = require('../services/payment.service');
const { STATUS } = require('../models/payment.model');

const FINAL_STATUSES = [STATUS.SUCCESS, STATUS.FAILED];

// POST /generate-payment
async function generatePayment(req, res) {
    const { deviceId, manufacturer, modelNo } = req.body ?? {};

    const missing = Object.entries({ deviceId, manufacturer, modelNo })
        .filter(([, value]) => !value)
        .map(([key]) => key);
    if (missing.length) {
        return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }

    try {
        const result = await paymentService.generatePayment({ deviceId, manufacturer, modelNo });
        return res.status(201).json(result);
    } catch (error) {
        if (error instanceof paymentService.TooManySessionsError) {
            return res.status(503).json({ error: error.message });
        }
        console.error('generate-payment failed:', error.message);
        return res.status(500).json({ error: `Could not generate payment: ${error.message}` });
    }
}

// GET /get-payment-status?paymentId=...
async function getPaymentStatus(req, res) {
    const { paymentId } = req.query;
    if (!paymentId) {
        return res.status(400).json({ error: 'Missing required query parameter: paymentId' });
    }

    try {
        const result = await paymentService.getPaymentStatus(paymentId);
        if (!result) return res.status(404).json({ error: `Unknown paymentId: ${paymentId}` });
        return res.status(200).json(result);
    } catch (error) {
        console.error('get-payment-status failed:', error.message);
        return res.status(500).json({ error: 'Could not read payment status' });
    }
}

// PUT /payment-finalize
async function finalizePayment(req, res) {
    const { paymentId, status, message } = req.body ?? {};

    if (!paymentId) return res.status(400).json({ error: 'Missing required field: paymentId' });
    if (!FINAL_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `status must be one of: ${FINAL_STATUSES.join(', ')}`
        });
    }

    try {
        const result = await paymentService.finalizePayment({ paymentId, status, message });
        if (!result) return res.status(404).json({ error: `Unknown paymentId: ${paymentId}` });

        const { payment, alreadyFinal } = result;
        return res.status(200).json({
            paymentId: payment.paymentId,
            status: payment.status,
            message: payment.message ?? null,
            finalizedAt: payment.finalizedAt ?? null,
            // Flagged rather than erroring, so a retried finalize is harmless.
            alreadyFinal
        });
    } catch (error) {
        console.error('payment-finalize failed:', error.message);
        return res.status(500).json({ error: 'Could not finalize payment' });
    }
}

module.exports = { generatePayment, getPaymentStatus, finalizePayment };
