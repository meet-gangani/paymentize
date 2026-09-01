const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const sessions = require('./src/services/session.manager');

async function start() {
    await db.connect();

    const app = createApp();
    const server = app.listen(config.port, () => {
        console.log(`Server listening at http://localhost:${config.port}`);
        console.log(`Admin panel at    http://localhost:${config.port}/admin`);
        console.log(`Browser mode: ${config.headless ? 'headless' : 'headful'}, ` +
            `max ${config.maxSessions} sessions, ` +
            `idle timeout ${Math.round(config.idleTimeoutMs / 60000)} min`);
    });

    // Browsers are child processes; without this they outlive the server.
    const shutdown = async signal => {
        console.log(`\n${signal} received - closing open browsers...`);
        const closed = await sessions.closeAll(`Server shut down (${signal})`);
        console.log(`Closed ${closed} browser session(s)`);
        server.close();
        await db.disconnect().catch(() => { });
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(error => {
    console.error('Failed to start:', error.message);
    process.exit(1);
});
