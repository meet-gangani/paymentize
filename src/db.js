const mongoose = require('mongoose');
const config = require('./config');
const { Payment, STATUS } = require('./models/payment.model');

async function connect() {
    mongoose.set('strictQuery', true);
    await mongoose.connect(config.mongoUri);
    console.log(`MongoDB connected: ${mongoose.connection.name}`);
    await sweepOrphanedSessions();
}

// Live sessions only exist in this process's memory, so anything still marked
// open in the database is a leftover from a previous run - its browser died with
// that process. Fail those rows so the admin counts stay honest.
async function sweepOrphanedSessions() {
    const result = await Payment.updateMany(
        { status: STATUS.PENDING, browserOpen: true },
        {
            $set: {
                status: STATUS.FAILED,
                browserOpen: false,
                message: 'Session lost - server restarted',
                finalizedAt: new Date()
            }
        }
    );
    if (result.modifiedCount) {
        console.log(`Swept ${result.modifiedCount} orphaned session(s) from a previous run`);
    }
}

async function disconnect() {
    await mongoose.connection.close();
}

module.exports = { connect, disconnect };
