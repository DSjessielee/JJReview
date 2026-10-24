const $ = (sel, root = document) => root.querySelector(sel);

// ---------- shared helpers ----------

function parseDate(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split('/').map(Number);
  return new Date(y, m - 1, d);
}

// "5.69 Black (SA)" or "0.50 Red 1.20 Black" -> 5.69 / 1.70
function parseMps(text) {
  return (String(text || '').match(/\d+(\.\d+)?/g) || []).reduce((sum, n) => sum + Number(n), 0);
}

const fmtPct = (v) => (v == null ? '–' : `${v.toFixed(2)}%`);
const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const share = (n, total) => (total ? `${Math.round((100 * n) / total)}% of ${total}` : '');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

function renderTiles(root, tiles) {
  $('.tiles', root).innerHTML = tiles.map(([label, value, note]) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note || ''}</div></div>`).join('');
}

// Percentage-over-time chart: one dot per item plus a 5-item rolling average.
// items: [{ date, pct }], tooltip(item, rollingAvg) -> html
function renderChart(root, items, tooltip) {
  const el = $('.chart', root);
  if (!items.length) { el.innerHTML = '<div class="empty">Nothing to chart yet.</div>'; return; }

  const W = el.clientWidth || 800, H = W < 600 ? 220 : 280, m = { t: 12, r: 16, b: 28, l: 40 };
  const pcts = items.map((g) => g.pct);
  const lo = Math.max(0, Math.floor(Math.min(30, ...pcts) / 10) * 10);
  const hi = Math.min(100, Math.ceil(Math.max(70, ...pcts) / 10) * 10);
  const first = items[0].date, last = items[items.length - 1].date;
  const t0 = first.getTime(), t1 = last.getTime();
  const x = (d) => m.l + (t1 === t0 ? (W - m.l - m.r) / 2 : ((d.getTime() - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const rolling = items.map((g, i) => avg(items.slice(Math.max(0, i - 4), i + 1).map((r) => r.pct)));
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="Percentage over time">`;
  for (let v = lo; v <= hi; v += 10) {
    svg += `<line class="${v === 50 ? 'ref' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<g class="axis"><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text></g>`;
  }
  const ticks = [];
  for (let yr = first.getFullYear() + 1; yr <= last.getFullYear(); yr++) ticks.push([new Date(yr, 0, 1), String(yr)]);
  if (!ticks.length) ticks.push([first, fmtDate(first)], [last, fmtDate(last)]);
  ticks.forEach(([d, label]) => {
    const px = x(d);
    const anchor = px < m.l + 30 ? 'start' : px > W - m.r - 30 ? 'end' : 'middle';
    svg += `<g class="axis"><text x="${px}" y="${H - 8}" text-anchor="${anchor}">${label}</text></g>`;
  });

  svg += `<path class="avg" d="${items.map((g, i) => `${i ? 'L' : 'M'}${x(g.date)},${y(rolling[i])}`).join('')}"/>`;
  svg += `<line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  svg += items.map((g, i) => `<circle class="pt" data-i="${i}" cx="${x(g.date)}" cy="${y(g.pct)}" r="4"/>`).join('');
  svg += '</svg>';
  el.innerHTML = svg;

  const svgEl = $('svg', el), cross = $('.cross', el), tip = $('#tooltip');
  let hovered = null;
  const hide = () => {
    tip.hidden = true; cross.setAttribute('visibility', 'hidden');
    if (hovered) hovered.classList.remove('hover');
  };
  // Pointer events cover mouse hover and touch: tap or drag a finger across the chart.
  const show = (e) => {
    const box = svgEl.getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    items.forEach((g, i) => { if (Math.abs(x(g.date) - mx) < Math.abs(x(items[best].date) - mx)) best = i; });
    const g = items[best];
    if (hovered) hovered.classList.remove('hover');
    hovered = $(`.pt[data-i="${best}"]`, el);
    hovered.classList.add('hover');
    cross.setAttribute('x1', x(g.date)); cross.setAttribute('x2', x(g.date)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = tooltip(g, rolling[best]);
    tip.hidden = false;
    // Keep the tooltip on screen; for touch, put it above the finger so it isn't covered.
    const above = e.pointerType === 'touch';
    const left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8));
    const top = above ? e.clientY - tip.offsetHeight - 24 : e.clientY + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tip.offsetHeight - 8))}px`;
  };
  svgEl.addEventListener('pointermove', show);
  svgEl.addEventListener('pointerdown', show);
  svgEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  el.hideTooltip = hide;
}

// On touch screens the tooltip stays up until you tap somewhere outside the chart.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.chart svg, .donut svg')) return;
  document.querySelectorAll('.chart').forEach((c) => c.hideTooltip && c.hideTooltip());
});

// Sortable table: columns = [{ key, label, num, fmt }]. On phones each row is shown as a
// card (CSS reads each cell's data-label), and a "Sort by" menu replaces the header row.
function renderTable(table, columns, rows, sort) {
  const sorted = [...rows].sort((a, b) => {
    const va = a[sort.key] ?? -Infinity, vb = b[sort.key] ?? -Infinity;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  const resort = (next) => renderTable(table, columns, rows, next);
  table.innerHTML = `<thead><tr>${columns.map((c) =>
    `<th class="${c.num ? 'num' : ''}" data-key="${c.key}" ${sort.key === c.key ? `data-dir="${sort.dir}"` : ''}>${c.label}</th>`).join('')}</tr></thead>` +
    `<tbody>${sorted.map((r) => `<tr>${columns.map((c) =>
      `<td class="${c.num ? 'num' : ''}" data-label="${esc(c.label)}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.key;
    resort({ key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' });
  }));

  const wrap = table.closest('.table-wrap');
  let sortBar = wrap.previousElementSibling;
  if (!sortBar || !sortBar.classList.contains('sort-bar')) {
    sortBar = document.createElement('label');
    sortBar.className = 'sort-bar';
    wrap.before(sortBar);
  }
  sortBar.innerHTML = `Sort by <select>${columns.flatMap((c) => ['desc', 'asc'].map((dir) =>
    `<option value="${c.key}|${dir}" ${sort.key === c.key && sort.dir === dir ? 'selected' : ''}>${esc(c.label)} ${dir === 'desc' ? '↓' : '↑'}</option>`)).join('')}</select>`;
  sortBar.querySelector('select').addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split('|');
    resort({ key, dir });
  });
}

// Chip slicer. `selection` is null when everything is selected, else a Set of keys.
// Like a spreadsheet slicer: from "everything", a click keeps just that chip; after
// that, clicks toggle chips in and out; clearing the last one goes back to everything.
// Long lists show the first `collapse` chips (plus any selected) behind a "+N more" toggle.
function renderChipSlicer(el, label, options, selection, onChange, collapse = 8) {
  const keys = new Set(options.map((o) => o.key));
  // Keep selected people visible even if the other filters leave them with 0 games.
  if (selection) selection.forEach((k) => { if (!keys.has(k)) options.push({ key: k, label: k, count: 0 }); });
  const expanded = el.dataset.expanded === 'true';
  const shown = expanded ? options : options.filter((o, i) => i < collapse || (selection && selection.has(o.key)));
  const hidden = options.length - shown.length;
  el.innerHTML =
    `<span class="slicer-label">${esc(label)}</span>` +
    shown.map((o) => `<button type="button" class="chip" data-key="${esc(o.key)}" aria-pressed="${!selection || selection.has(o.key)}">` +
      `${esc(o.label)} <span class="count">${o.count}</span></button>`).join('') +
    (hidden > 0 ? `<button type="button" class="chip more">+${hidden} more</button>` : '') +
    (expanded && options.length > collapse ? '<button type="button" class="chip more">Show fewer</button>' : '') +
    (selection ? '<button type="button" class="chip reset">Show all</button>' : '');

  el.querySelectorAll('.chip[data-key]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.key;
    let next;
    if (!selection) next = new Set([key]);
    else {
      next = new Set(selection);
      if (next.has(key)) next.delete(key); else next.add(key);
    }
    onChange(next.size ? next : null);
  }));
  el.querySelectorAll('.chip.more').forEach((b) => b.addEventListener('click', () => {
    el.dataset.expanded = String(!expanded);
    onChange(selection);
  }));
  const reset = $('.chip.reset', el);
  if (reset) reset.addEventListener('click', () => onChange(null));
}

// Options for a chip slicer: one per key, most frequent first.
function countOptions(keyLists) {
  const counts = new Map();
  keyLists.forEach((ks) => ks.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: key, count }));
}

function groupBy(items, keyFn) {
  const map = new Map();
  items.forEach((it) => { const k = keyFn(it); if (!map.has(k)) map.set(k, []); map.get(k).push(it); });
  return [...map];
}

function fillYears(root, dates) {
  const sel = $('.year', root), current = sel.value;
  const years = [...new Set(dates.map((d) => d.slice(-4)))].sort().reverse();
  sel.innerHTML = '<option value="all">All years</option>' + years.map((y) => `<option>${y}</option>`).join('');
  sel.value = years.includes(current) ? current : 'all';
}

const inYear = (root, d) => $('.year', root).value === 'all' || String(d.getFullYear()) === $('.year', root).value;

function renderStatus(root, data) {
  $('.updated', root).textContent = data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleString()}` : 'Never refreshed – click Refresh';
  const locked = data.games.filter((g) => g.status === 'login');
  const failed = data.games.filter((g) => g.status === 'error');
  const notice = $('.status-notice', root);
  notice.hidden = !locked.length && !failed.length;
  notice.innerHTML = [
    locked.length ? `${locked.length} results need an ACBL login. ${esc(locked[0].statusMessage || '')}` : '',
    failed.length ? `${failed.length} results failed to load; Refresh will retry them.` : ''
  ].filter(Boolean).join('<br>');
}

// ---------- Club Game Results ----------

const club = {
  root: $('#club-panel'),
  partners: null, // null = every partner
  data: { games: [] },

  findRow(rows, name) {
    const target = name.trim().toLowerCase();
    return rows.find((r) => r.players.some((p) => p.name.toLowerCase() === target))
      || rows.find((r) => r.names.toLowerCase().includes(target));
  },

  // ACBL player number -> the most recent name shown for it, so a player listed under
  // different names over time (e.g. "Yixin - Mark Pan", later "Mark Pan") counts as one.
  latestNames() {
    const names = new Map();
    [...this.data.games].sort((a, b) => parseDate(b.date) - parseDate(a.date)).forEach((g) =>
      (g.rows || []).forEach((r) => (r.players || []).forEach((p) => {
        if (p.playerId && !names.has(p.playerId)) names.set(p.playerId, p.name);
      })));
    return names;
  },

  games(name) {
    const target = name.trim().toLowerCase();
    const latest = this.latestNames();
    const display = (p) => latest.get(p.playerId) || p.name;
    return this.data.games
      .filter((g) => g.status === 'ok' && g.rows && g.rows.length)
      .map((g) => {
        const row = this.findRow(g.rows, name);
        if (!row) return null;
        // Place within everyone who sat the same direction (NS or EW) across all sections.
        const field = g.rows.filter((r) => r.direction === row.direction && r.pct != null);
        return {
          id: g.id, date: parseDate(g.date), event: g.event, rating: g.rating,
          section: row.section, direction: row.direction, strat: row.strat,
          partner: row.players.filter((p) => p.name.toLowerCase() !== target).map(display).join(' & ')
            || row.names.split(' - ').find((n) => n.toLowerCase() !== target) || '',
          pct: row.pct, score: row.score, mps: parseMps(row.mps), mpsText: row.mps,
          place: 1 + field.filter((r) => r.pct > row.pct).length, of: field.length
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.date - b.date);
  },

  render() {
    const root = this.root;
    const name = $('.player', root).value.trim() || 'Jessie Lee';
    $('.player-label', root).textContent = name;
    const yearGames = this.games(name).filter((g) => inYear(root, g.date));
    renderChipSlicer($('.partner-slicer', root), 'Partner', countOptions(yearGames.map((g) => [g.partner])),
      this.partners, (sel) => { this.partners = sel; this.render(); });
    const games = this.partners ? yearGames.filter((g) => this.partners.has(g.partner)) : yearGames;
    const played = this.data.games.filter((g) => g.status === 'ok' && inYear(root, parseDate(g.date))).length;
    const pcts = games.map((g) => g.pct);
    const best = games.reduce((b, g) => (!b || g.pct > b.pct ? g : b), null);
    const top3 = games.filter((g) => g.place <= 3).length;

    renderTiles(root, [
      ['Games played', games.length, `of ${played} Friday games with results`],
      ['Average %', fmtPct(avg(pcts)), games.length ? `median ${fmtPct(median(pcts))}` : ''],
      ['Best game', best ? fmtPct(best.pct) : '–', best ? fmtDate(best.date) : ''],
      ['Masterpoints', games.reduce((s, g) => s + g.mps, 0).toFixed(2), 'total won'],
      ['1st in direction', games.filter((g) => g.place === 1).length, 'NS or EW field'],
      ['Top 3 in direction', top3, share(top3, games.length)]
    ]);

    renderChart(root, games, (g, roll) => `<b>${fmtDate(g.date)}</b>${esc(g.event)}<br>with ${esc(g.partner)}<br>` +
      `${fmtPct(g.pct)} · ${g.place} of ${g.of} ${esc(g.direction)}<br>5-game avg ${fmtPct(roll)}`);

    renderTable($('.partners', root), [
      { key: 'partner', label: 'Partner' },
      { key: 'games', label: 'Games', num: true },
      { key: 'avgPct', label: 'Avg %', num: true, fmt: (r) => fmtPct(r.avgPct) },
      { key: 'bestPct', label: 'Best %', num: true, fmt: (r) => fmtPct(r.bestPct) },
      { key: 'firsts', label: '1st places', num: true },
      { key: 'mps', label: 'MPs', num: true, fmt: (r) => r.mps.toFixed(2) },
      { key: 'last', label: 'Last played', num: true, fmt: (r) => fmtDate(new Date(r.last)) }
    ], groupBy(games, (g) => g.partner).map(([partner, gs]) => ({
      partner,
      games: gs.length,
      avgPct: avg(gs.map((g) => g.pct)),
      bestPct: Math.max(...gs.map((g) => g.pct)),
      firsts: gs.filter((g) => g.place === 1).length,
      mps: gs.reduce((s, g) => s + g.mps, 0),
      last: Math.max(...gs.map((g) => g.date.getTime()))
    })), { key: 'games', dir: 'desc' });

    renderTable($('.log', root), [
      { key: 'date', label: 'Date', fmt: (r) => `<a href="https://my.acbl.org/club-results/details/${r.id}" target="_blank" rel="noopener">${fmtDate(r.date)}</a>` },
      { key: 'event', label: 'Event' },
      { key: 'rating', label: 'Rating' },
      { key: 'partner', label: 'Partner' },
      { key: 'section', label: 'Seat', fmt: (r) => `${esc(r.section)} ${esc(r.direction)}` },
      { key: 'strat', label: 'Strat' },
      { key: 'place', label: 'Place', num: true, fmt: (r) => `<span class="${r.place === 1 ? 'first' : ''}">${r.place}</span> <span class="muted">/ ${r.of}</span>` },
      { key: 'score', label: 'Score', num: true, fmt: (r) => (r.score ?? '–') },
      { key: 'pct', label: '%', num: true, fmt: (r) => fmtPct(r.pct) },
      { key: 'mps', label: 'MPs', num: true, fmt: (r) => (r.mps ? esc(r.mpsText) : '<span class="muted">–</span>') }
    ], games, { key: 'date', dir: 'desc' });

    renderStatus(root, this.data);
  }
};

// ---------- Masterpoints by color (tournaments + club) ----------

// Built from ACBL's official masterpoint record (my.acbl.org masterpoint history),
// which includes every award: other clubs, online games, and pending points.
const MP_COLORS = ['Black', 'Red', 'Silver', 'Gold', 'Platinum', 'Online'];
const CLUB_RATINGS = /club|charity/i; // "Club MPs", "Club Tournament", "Charity Game"
let mpHistory = { games: [] };

function renderMasterpointCard(root) {
  const totals = Object.fromEntries(MP_COLORS.map((c) => [c, { color: c, live: 0, club: 0 }]));
  let pending = 0;
  mpHistory.games.forEach((a) => {
    const t = totals[a.color] || (totals[a.color] = { color: a.color, live: 0, club: 0 });
    t[CLUB_RATINGS.test(a.rating) ? 'club' : 'live'] += a.points;
    if (a.pending) pending += a.points;
  });
  const rows = Object.values(totals).map((t) => ({ ...t, total: t.live + t.club })).filter((r) => r.total > 0);
  const grand = rows.reduce((s, r) => s + r.total, 0);
  $('.mp-note', root).textContent = pending
    ? `Includes ${pending.toFixed(2)} pending points (ACBL posts them at its monthly update).` : '';

  // Donut: one slice per color, 2px surface gap between slices.
  const el = $('.donut', root);
  const R = 90, r = 58, C = 100;
  const pt = (a, rad) => [C + rad * Math.sin(a), C - rad * Math.cos(a)];
  let angle = 0;
  const slices = rows.map((row) => {
    const sweep = (row.total / grand) * 2 * Math.PI;
    const [a0, a1] = [angle, angle + sweep];
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r);
    const d = rows.length === 1
      ? `M${C},${C - R}A${R},${R} 0 1 1 ${C - 0.01},${C - R}L${C - 0.01},${C - r}A${r},${r} 0 1 0 ${C},${C - r}Z`
      : `M${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${large} 0 ${x3},${y3}Z`;
    return `<path class="slice mp-${row.color.toLowerCase()}" data-color="${row.color}" d="${d}"/>`;
  }).join('');
  el.innerHTML = grand
    ? `<svg viewBox="0 0 200 200" role="img" aria-label="Masterpoints by color">${slices}` +
      `<text x="100" y="98" text-anchor="middle" class="donut-total">${grand.toFixed(2)}</text>` +
      `<text x="100" y="118" text-anchor="middle" class="donut-label">masterpoints</text></svg>`
    : '<div class="empty">No masterpoints yet.</div>';

  const tip = $('#tooltip');
  el.querySelectorAll('.slice').forEach((s) => {
    const row = rows.find((x) => x.color === s.dataset.color);
    const show = (e) => {
      tip.innerHTML = `<b>${row.color}: ${row.total.toFixed(2)}</b>${Math.round((100 * row.total) / grand)}% of all points<br>` +
        `Tournaments ${row.live.toFixed(2)} · Club ${row.club.toFixed(2)}`;
      tip.hidden = false;
      const top = e.pointerType === 'touch' ? e.clientY - tip.offsetHeight - 24 : e.clientY + 14;
      tip.style.left = `${Math.max(8, Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tip.offsetHeight - 8))}px`;
    };
    s.addEventListener('pointermove', show);
    s.addEventListener('pointerdown', show);
    s.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') tip.hidden = true; });
  });

  const sum = (k) => rows.reduce((t, x) => t + x[k], 0);
  const swatch = (c) => `<i class="swatch mp-${c.toLowerCase()}"></i>${c}`;
  $('.mp-table', root).innerHTML =
    '<thead><tr><th>Color</th><th class="num">Tournaments</th><th class="num">Club</th><th class="num">Total</th><th class="num">Share</th></tr></thead><tbody>' +
    rows.map((x) => `<tr><td data-label="Color">${swatch(x.color)}</td>` +
      `<td class="num" data-label="Tournaments">${x.live.toFixed(2)}</td>` +
      `<td class="num" data-label="Club">${x.club.toFixed(2)}</td>` +
      `<td class="num" data-label="Total"><b>${x.total.toFixed(2)}</b></td>` +
      `<td class="num" data-label="Share">${Math.round((100 * x.total) / grand)}%</td></tr>`).join('') +
    `<tr class="total-row"><td data-label="Color">All colors</td><td class="num" data-label="Tournaments">${sum('live').toFixed(2)}</td>` +
    `<td class="num" data-label="Club">${sum('club').toFixed(2)}</td><td class="num" data-label="Total"><b>${grand.toFixed(2)}</b></td>` +
    '<td class="num" data-label="Share">100%</td></tr></tbody>';
}

// ---------- ACBL Game Results (tournaments) ----------

const LEVELS = ['NABC', 'Regional', 'Sectional', 'Other'];

// Tournament level, inferred from the tournament name.
function tournamentLevel(name) {
  if (/NABC/i.test(name)) return 'NABC';
  if (/Regional/i.test(name)) return 'Regional';
  if (/Sectional|\bSect\b/i.test(name)) return 'Sectional';
  return 'Other';
}

const live = {
  root: $('#live-panel'),
  data: { games: [] },
  levels: new Set(LEVELS),
  partners: null, // null = everyone

  renderSlicer(sessions) {
    const el = $('.slicer', this.root);
    el.innerHTML = LEVELS.map((lv) => {
      const n = sessions.filter((s) => s.level === lv).length;
      return `<button type="button" data-level="${lv}" aria-pressed="${this.levels.has(lv)}">${lv} <span class="count">${n}</span></button>`;
    }).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const lv = b.dataset.level;
      // Like a spreadsheet slicer: from "everything on", a click shows just that level;
      // after that, clicks toggle levels in and out. Never leave nothing selected.
      if (this.levels.size === LEVELS.length) this.levels = new Set([lv]);
      else if (this.levels.has(lv)) this.levels.delete(lv);
      else this.levels.add(lv);
      if (!this.levels.size) this.levels = new Set(LEVELS);
      this.render();
    }));
  },

  sessions() {
    return this.data.games.map((s) => {
      const sum = s.summary || {};
      const others = sum.others || [];
      return {
        ...s,
        date: parseDate(s.date),
        dateText: s.date,
        type: s.isTeams ? 'Teams' : 'Pairs',
        level: tournamentLevel(s.tournament),
        partner: others.length ? others.join(', ') : '–',
        flight: sum.flight || '',
        rank: parseInt(sum.overallRank, 10) || null,
        tables: sum.tables || null,
        counted: s.mpsStruck ? 0 : s.mps
      };
    }).sort((a, b) => a.date - b.date);
  },

  render() {
    const root = this.root;
    renderMasterpointCard(root);
    const yearSessions = this.sessions().filter((s) => inYear(root, s.date));
    this.renderSlicer(yearSessions);
    const levelSessions = yearSessions.filter((s) => this.levels.has(s.level));
    const people = (s) => (s.summary && s.summary.others) || [];
    renderChipSlicer($('.partner-slicer', root), 'Partner / teammate', countOptions(levelSessions.map(people)),
      this.partners, (sel) => { this.partners = sel; this.render(); });
    // A session matches if any selected person was Jessie's partner or on her team.
    const all = this.partners ? levelSessions.filter((s) => people(s).some((p) => this.partners.has(p))) : levelSessions;
    const pairs = all.filter((s) => s.pct != null);
    const best = pairs.reduce((b, s) => (!b || s.pct > b.pct ? s : b), null);
    // Group by ACBL's tournament id (first part of the session id): the same name recurs yearly.
    const tournaments = groupBy(all, (s) => s.id.split('/')[0]);
    const top3 = all.filter((s) => s.rank && s.rank <= 3).length;

    renderTiles(root, [
      ['Sessions played', all.length, `${pairs.length} pairs · ${all.length - pairs.length} teams`],
      ['Tournaments', tournaments.length, ''],
      ['Masterpoints', all.reduce((t, s) => t + s.counted, 0).toFixed(2), 'not counting replaced awards'],
      ['Average pairs %', fmtPct(avg(pairs.map((s) => s.pct))), pairs.length ? `median ${fmtPct(median(pairs.map((s) => s.pct)))}` : ''],
      ['Best pairs session', best ? fmtPct(best.pct) : '–', best ? `${esc(best.event)}, ${fmtDate(best.date)}` : ''],
      ['Top 3 overall', top3, share(top3, all.filter((s) => s.rank).length)]
    ]);

    renderChart(root, pairs, (s, roll) => `<b>${fmtDate(s.date)} · ${esc(s.session)}</b>${esc(s.tournament)}<br>${esc(s.event)}<br>` +
      `with ${esc(s.partner)}<br>${fmtPct(s.pct)}${s.rank ? ` · overall ${s.rank}` : ''}<br>5-session avg ${fmtPct(roll)}`);

    renderTable($('.tournaments', root), [
      { key: 'tournament', label: 'Tournament' },
      { key: 'level', label: 'Level', fmt: (r) => `<span class="pill">${r.level}</span>` },
      { key: 'start', label: 'Dates', num: true, fmt: (r) => fmtDate(new Date(r.start)) + (r.end !== r.start ? ` – ${fmtDate(new Date(r.end))}` : '') },
      { key: 'sessions', label: 'Sessions', num: true },
      { key: 'avgPct', label: 'Avg pairs %', num: true, fmt: (r) => fmtPct(r.avgPct) },
      { key: 'bestRank', label: 'Best overall', num: true, fmt: (r) => r.bestRank ?? '–' },
      { key: 'mps', label: 'MPs', num: true, fmt: (r) => r.mps.toFixed(2) }
    ], tournaments.map(([, ss]) => {
      const tournament = ss[0].tournament;
      const p = ss.filter((s) => s.pct != null).map((s) => s.pct);
      const ranks = ss.map((s) => s.rank).filter(Boolean);
      return {
        tournament,
        level: ss[0].level,
        start: Math.min(...ss.map((s) => s.date.getTime())),
        end: Math.max(...ss.map((s) => s.date.getTime())),
        sessions: ss.length,
        avgPct: avg(p),
        bestRank: ranks.length ? Math.min(...ranks) : null,
        mps: ss.reduce((t, s) => t + s.counted, 0)
      };
    }), { key: 'start', dir: 'desc' });

    // One row per person: everyone Jessie partnered or played on a team with.
    const withPerson = all.flatMap((s) => (s.summary?.others || []).map((person) => ({ person, s })));
    renderTable($('.partners', root), [
      { key: 'person', label: 'Played with' },
      { key: 'sessions', label: 'Sessions', num: true },
      { key: 'pairs', label: 'As partner', num: true },
      { key: 'teams', label: 'As teammate', num: true },
      { key: 'avgPct', label: 'Avg pairs %', num: true, fmt: (r) => fmtPct(r.avgPct) },
      { key: 'mps', label: 'MPs together', num: true, fmt: (r) => r.mps.toFixed(2) },
      { key: 'last', label: 'Last played', num: true, fmt: (r) => fmtDate(new Date(r.last)) }
    ], groupBy(withPerson, (x) => x.person).map(([person, xs]) => {
      const ss = xs.map((x) => x.s);
      return {
        person,
        sessions: ss.length,
        pairs: ss.filter((s) => !s.isTeams).length,
        teams: ss.filter((s) => s.isTeams).length,
        avgPct: avg(ss.filter((s) => s.pct != null).map((s) => s.pct)),
        mps: ss.reduce((t, s) => t + s.counted, 0),
        last: Math.max(...ss.map((s) => s.date.getTime()))
      };
    }), { key: 'sessions', dir: 'desc' });

    renderTable($('.log', root), [
      { key: 'date', label: 'Date', fmt: (r) => `<a href="${esc(r.summaryUrl)}" target="_blank" rel="noopener">${fmtDate(r.date)}</a>` },
      { key: 'session', label: 'Session' },
      { key: 'tournament', label: 'Tournament' },
      { key: 'level', label: 'Level' },
      { key: 'event', label: 'Event' },
      { key: 'type', label: 'Type', fmt: (r) => `<span class="pill">${r.type}</span>` },
      { key: 'partner', label: 'Partner / teammates' },
      { key: 'flight', label: 'Flight' },
      { key: 'rank', label: 'Overall', num: true, fmt: (r) => (r.rank ? `<span class="${r.rank === 1 ? 'first' : ''}">${r.rank}</span>` : '<span class="muted">–</span>') },
      { key: 'pct', label: '%', num: true, fmt: (r) => fmtPct(r.pct) },
      { key: 'mps', label: 'MPs', num: true, fmt: (r) => (!r.mps ? '<span class="muted">–</span>' : r.mpsStruck ? `<s>${r.mps.toFixed(2)}</s>` : r.mps.toFixed(2)) },
      { key: 'color', label: 'Color' }
    ], all, { key: 'date', dir: 'desc' });

    renderStatus(root, this.data);
  }
};

// ---------- loading, refresh, tabs ----------

const views = { club, live };

// The published copy is read-only: data comes from JSON files and there's no Refresh.
const STATIC = !!window.JJ_STATIC;
if (STATIC) document.body.classList.add('static');

async function load(name) {
  const data = await (await fetch(STATIC ? `data/${name}.json` : `/api/${name}`)).json();
  // The masterpoint history isn't a tab of its own; it feeds the ACBL tab's color card.
  if (name === 'history') {
    mpHistory = data;
    live.render();
    return;
  }
  const view = views[name];
  view.data = data;
  fillYears(view.root, view.data.games.map((g) => g.date));
  view.render();
}

async function pollRefresh() {
  if (STATIC) return;
  const job = await (await fetch('/api/refresh/status')).json();
  for (const [name, view] of Object.entries(views)) {
    const mine = job.source === name || (name === 'live' && job.source === 'history');
    const box = $('.progress', view.root);
    box.hidden = !mine || (!job.running && !job.error);
    $('.progress-text', box).textContent = job.error
      ? `Refresh failed: ${job.error}`
      : `${job.message} (${job.done} of ${job.total || '?'})`;
    $('.bar-fill', box).style.width = job.total ? `${(100 * job.done) / job.total}%` : '0';
    $('.refresh', view.root).disabled = job.running;
  }
  if (job.source && (job.running || job.message === 'Done')) await load(job.source);
  if (job.running) setTimeout(pollRefresh, 2000);
}

function showTab(name) {
  if (!views[name]) name = 'club';
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.tab !== name; });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0); // the #hash would otherwise jump past the title, under the pinned header
  $('#tooltip').hidden = true;
  views[name].render(); // the chart sizes itself to the now-visible panel
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
for (const [name, view] of Object.entries(views)) {
  $('.refresh', view.root).addEventListener('click', async () => {
    const res = await fetch(`/api/${name}/refresh`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error);
    pollRefresh();
  });
  $('.year', view.root).addEventListener('change', () => view.render());
}
$('.player', club.root).addEventListener('change', () => { club.partners = null; club.render(); });
window.addEventListener('resize', () => {
  const active = $('.tab.active');
  if (active) views[active.dataset.tab].render();
});

Promise.all([...Object.keys(views), 'history'].map(load)).then(() => {
  showTab(location.hash.slice(1));
  pollRefresh();
});
