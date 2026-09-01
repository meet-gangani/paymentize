const mongoose = require('mongoose');

const STATUS = {
    PENDING: 'pending',
    SUCCESS: 'success',
    FAILED: 'failed'
};

// One entry per QR the session has minted, so an expired QR can still be traced.
const qrHistorySchema = new mongoose.Schema({
    qrValue: String,
    generatedAt: Date,
    expireAt: Date
}, { _id: false });

const paymentSchema = new mongoose.Schema({
    paymentId: { type: String, required: true, unique: true },

    deviceId: { type: String, required: true },
    manufacturer: { type: String, required: true },
    modelNo: { type: String, required: true },

    // The identity drawn from static/emails.json + static/numbers.json and typed
    // into the checkout form, kept so a payment can be traced back to it.
    email: String,
    phone: String,

    status: {
        type: String,
        enum: Object.values(STATUS),
        default: STATUS.PENDING,
        index: true
    },

    // The QR currently on screen, and when it genuinely lapses (generated + 5 min).
    // The background loop swaps it 30s before this.
    qrValue: String,
    expireAt: Date,
    qrHistory: [qrHistorySchema],

    // Failed attempts the payer made before succeeding or giving up. A failure is
    // not terminal - a fresh QR is issued each time so they can retry.
    failedAttempts: { type: Number, default: 0 },
    lastFailureAt: Date,

    // Finalize message, or the reason a session was failed automatically.
    message: String,
    // Cashfree's transactionId, once a reconciliation poll reveals it.
    transactionId: String,

    browserOpen: { type: Boolean, default: false },
    lastActivityAt: Date,
    finalizedAt: Date
}, { timestamps: true });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = { Payment, STATUS };
