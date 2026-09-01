// One Chromium process, many isolated incognito contexts.
//
// Launching a browser per session spins up a fresh master/GPU/renderer set each
// time (~250-350MB). An incognito BrowserContext instead reuses the same base
// process while keeping its own cookie jar, cache and storage - the same
// isolation an incognito window gives you - for roughly 100-150MB per context.
const puppeteer = require('puppeteer');
const config = require('../config');

let browserPromise = null;
let shuttingDown = false;
const lostHandlers = new Set();

// Launch on first use and reuse thereafter. If Chromium dies the promise is
// cleared, so the next session transparently launches a replacement.
function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer
            .launch({ headless: config.headless })
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

module.exports = { createSessionContext, closeContext, onBrowserLost, contextCount, shutdown };
