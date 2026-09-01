// Supplies the email / phone pair typed into the checkout form. The pools live in
// static/emails.json and static/numbers.json so they can be edited without
// touching code. Loaded once at startup: edit the files, restart the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC_DIR = path.join(__dirname, '..', '..', 'static');
const EMAILS_FILE = path.join(STATIC_DIR, 'emails.json');
const NUMBERS_FILE = path.join(STATIC_DIR, 'numbers.json');

// 10 digits starting 6-9, which is what an Indian mobile number looks like and
// what the checkout's phone widget will accept.
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

function loadPool(file, label, validate) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`Could not read ${label} from ${file}: ${error.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`${file} must be a non-empty JSON array of ${label}`);
    }

    const bad = parsed.filter(entry => !validate(entry));
    if (bad.length) {
        throw new Error(`${file} contains invalid ${label}: ${bad.slice(0, 3).join(', ')}`);
    }

    return parsed;
}

const emails = loadPool(EMAILS_FILE, 'emails', value =>
    typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value));

const numbers = loadPool(NUMBERS_FILE, 'phone numbers', value =>
    typeof value === 'string' && INDIAN_MOBILE.test(value));

console.log(`Identity pools loaded: ${emails.length} emails, ${numbers.length} numbers`);

// crypto.randomInt avoids Math.random's modulo bias and needs no seeding.
const pick = pool => pool[crypto.randomInt(pool.length)];

// Email and number are drawn independently, so the pairing varies too.
function pickIdentity() {
    return { email: pick(emails), phone: pick(numbers) };
}

module.exports = { pickIdentity, poolSizes: () => ({ emails: emails.length, numbers: numbers.length }) };
