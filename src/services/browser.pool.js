// One Chromium process, many isolated incognito contexts.
//
// Launching a browser per session spins up a fresh master/GPU/renderer set each
// time (~250-350MB). An incognito BrowserContext instead reuses the same base
// process while keeping its own cookie jar, cache and storage - the same
// isolation an incognito window gives you.
//
// Measured on Windows 11 against the live checkout: ~140MB for the browser
// itself, ~110MB for a context parked on the form, and ~300MB once the Cashfree
// modal is open - the nested cross-origin iframe gets its own renderer under
// site isolation, so a live session costs roughly three times a parked one.
// Size MAX_SESSIONS off the 300MB figure, not the 110MB one.
const puppeteer = require('puppeteer');
const config = require('../config');

let browserPromise = null;
let shuttingDown = false;
const lostHandlers = new Set();

// Chromium throttles and backgrounds tabs it thinks nobody is looking at, which
// for us means the checkout page it is quietly loading. The rest is startup
// weight - first-run checks, extension and metrics traffic - that a server-side
// browser never needs. The sandbox is deliberately left ON: these pages are
// third-party.
const LAUNCH_ARGS = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-client-side-phishing-detection',
    '--no-first-run',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Prevents crashes when /dev/shm is small in VPS/Docker
];

// Launch on first use and reuse thereafter. If Chromium dies the promise is
// cleared, so the next session transparently launches a replacement.
function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer
            .launch({
                headless: config.headless,
                // Nothing on the checkout needs the GPU, and headless Chromium
                // spends real time setting one up.
                args: config.headless ? [...LAUNCH_ARGS, '--disable-gpu'] : LAUNCH_ARGS
            })
            .then(browser => {
                console.log(`Shared Chromium launched (${config.headless ? 'headless' : 'headful'})`);

                browser.once('disconnected', () => {
                    browserPromise = null;
                    if (shuttingDown) return;

                    console.error('Shared Chromium disconnected - all sessions are gone');
                    const handlers = [...lostHandlers];
                    lostHandlers.clear();
                    handlers.forEach(handler => handler());
                });

                return browser;
            })
            .catch(error => {
                browserPromise = null; // never cache a failed launch
                throw error;
            });
    }
    return browserPromise;
}

// Launch ahead of the first request. Chromium's cold start is a second or two
// that would otherwise land on whoever calls generate-payment first.
function warmUp() {
    return getBrowser().then(() => true).catch(error => {
        console.error('Chromium warm-up failed:', error.message);
        return false;
    });
}

// A context per session: isolated cookies/storage, shared process.
async function createSessionContext() {
    const browser = await getBrowser();
    const context = await browser.createIncognitoBrowserContext();

    let page;
    try {
        page = await context.newPage();
    } catch (error) {
        await context.close().catch(() => { });
        throw error;
    }

    return { context, page };
}

async function closeContext(context) {
    if (!context) return;
    await context.close().catch(() => { }); // already gone if the window was closed
}

// Register interest in the whole browser dying, which takes every session with it.
function onBrowserLost(handler) {
    lostHandlers.add(handler);
    return () => lostHandlers.delete(handler);
}

async function contextCount() {
    if (!browserPromise) return 0;
    const browser = await browserPromise.catch(() => null);
    if (!browser || !browser.isConnected()) return 0;
    // browserContexts() includes the default context, which holds no sessions.
    return browser.browserContexts().filter(c => c.isIncognito()).length;
}

async function shutdown() {
    if (!browserPromise) return;
    shuttingDown = true;

    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    lostHandlers.clear();

    if (browser) await browser.close().catch(() => { });
    shuttingDown = false;
}

module.exports = {
    warmUp,
    createSessionContext,
    closeContext,
    onBrowserLost,
    contextCount,
    shutdown
};
