// Builds the Express app. Kept separate from server.js so the app can be mounted
// and exercised without opening a database connection or binding a port.
const path = require('path');
const express = require('express');
const morganBody = require('morgan-body');

const paymentRoutes = require('./routes/payment.routes');
const adminRoutes = require('./routes/admin.routes');

function createApp({ logRequests = true } = {}) {
    const app = express();

    app.use(express.json());
    if (logRequests) morganBody(app);

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.static(path.join(__dirname, '..', 'public')));

    // Health check
    app.get('/test', (req, res) => {
        res.status(200).send('Server is working!');
    });

    app.use('/', paymentRoutes);
    app.use('/admin', adminRoutes);

    app.use((req, res) => {
        res.status(404).json({ error: 'Path not found!' });
    });

    return app;
}

module.exports = { createApp };
