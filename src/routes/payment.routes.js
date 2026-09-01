const express = require('express');
const controller = require('../controllers/payment.controller');

const router = express.Router();

router.post('/generate-payment', controller.generatePayment);
router.get('/get-payment-status', controller.getPaymentStatus);
router.put('/payment-finalize', controller.finalizePayment);

module.exports = router;
