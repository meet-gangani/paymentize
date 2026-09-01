// Polls /admin/stats.json and patches the DOM in place, so the page never flashes.
const POLL_INTERVAL_MS = 2000;

// Owned by the user, not the poll: every refresh re-requests whichever page they
// are on, so polling can never yank them back to page 1.
let currentPage = 1;
let pageSize = 20;

const els = {
    live: document.getElementById('live-indicator'),
    open: document.getElementById('stat-open'),
    success: document.getElementById('stat-success'),
    failed: document.getElementById('stat-failed'),
    pending: document.getElementById('stat-pending'),
    rows: document.getElementById('payment-rows'),
    pageSize: document.getElementById('page-size'),
    pageInfo: document.getElementById('page-info'),
    first: document.getElementById('page-first'),
    prev: document.getElementById('page-prev'),
    next: document.getElementById('page-next'),
    last: document.getElementById('page-last')
};

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatTime = value => value ? new Date(value).toLocaleTimeString() : '—';

function renderRows(payments) {
    if (!payments.length) {
        els.rows.innerHTML = '<tr class="empty"><td colspan="7">No payments yet</td></tr>';
        return;
    }

    els.rows.innerHTML = payments.map(p => `
        <tr>
            <td class="mono">${formatTime(p.createdAt)}</td>
            <td class="mono" title="${escapeHtml(p.paymentId)}">${escapeHtml(String(p.paymentId).slice(0, 8))}</td>
            <td>${escapeHtml(p.manufacturer)} ${escapeHtml(p.modelNo)}<br>
                <small class="mono">${escapeHtml(p.deviceId)}</small></td>
            <td><small class="mono">${escapeHtml(p.email || '—')}<br>${escapeHtml(p.phone || '—')}</small></td>
            <td><span class="badge badge-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
            <td class="mono">${formatTime(p.expireAt)}</td>
            <td><small>${escapeHtml(p.message || p.transactionId || '')}
                ${p.failedAttempts ? `<br><span class="retries">${p.failedAttempts} failed attempt${p.failedAttempts > 1 ? 's' : ''}</span>` : ''}
            </small></td>
        </tr>
    `).join('');
}

// Only the label and disabled states change - the buttons themselves are never
// rebuilt, so a click can't land on an element the poll just replaced.
function renderPager(pagination) {
    const { page, totalPages, total, from, to } = pagination;
    currentPage = page; // the server clamps, so adopt what it actually served

    els.pageInfo.textContent = total === 0
        ? 'No payments'
        : `${from}–${to} of ${total}  ·  page ${page} of ${totalPages}`;

    const atStart = page <= 1;
    const atEnd = page >= totalPages;
    els.first.disabled = atStart;
    els.prev.disabled = atStart;
    els.next.disabled = atEnd;
    els.last.disabled = atEnd;
    els.last.dataset.target = totalPages;
}

async function poll() {
    try {
        const response = await fetch(`/admin/stats.json?page=${currentPage}&limit=${pageSize}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const stats = await response.json();

        els.open.textContent = stats.openBrowsers;
        els.success.textContent = stats.successCount;
        els.failed.textContent = stats.failedCount;
        els.pending.textContent = stats.pendingCount;
        renderRows(stats.payments || []);
        renderPager(stats.pagination);

        els.live.textContent = `live · updated ${new Date().toLocaleTimeString()}`;
        els.live.classList.remove('stale');
    } catch (error) {
        els.live.textContent = `disconnected (${error.message})`;
        els.live.classList.add('stale');
    }
}

// Repoll immediately on any navigation so the table does not lag by up to 2s.
function goTo(page) {
    currentPage = Math.max(1, page);
    poll();
}

els.first.addEventListener('click', () => goTo(1));
els.prev.addEventListener('click', () => goTo(currentPage - 1));
els.next.addEventListener('click', () => goTo(currentPage + 1));
els.last.addEventListener('click', () => goTo(Number(els.last.dataset.target) || 1));

els.pageSize.addEventListener('change', event => {
    pageSize = Number(event.target.value) || 20;
    goTo(1); // row count changed, so the old page number is meaningless
});

poll();
setInterval(poll, POLL_INTERVAL_MS);
