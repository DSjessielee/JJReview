const path = require('path');
const { chromium } = require('playwright');

const CLUB_BASE = 'https://my.acbl.org';
const LIVE_BASE = 'https://live.acbl.org';
const PROFILE_DIR = path.join(__dirname, '.browser-profile');

// ACBL sits behind a Cloudflare bot check that blocks headless browsers, so we drive a
// real (visible) Chrome with a persistent profile. The window is parked off-screen.
async function openBrowser() {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1300, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-2400,-2400']
  });
}

async function gotoPastCloudflare(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  for (let i = 0; i < 30 && /Just a moment/i.test(await page.title()); i++) {
    await page.waitForTimeout(2000);
  }
  if (/Just a moment/i.test(await page.title())) {
    throw new Error('Stuck on the Cloudflare check. Re-run the refresh.');
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

const onLoginPage = (page) => /login\.acbl\.org/.test(page.url());

// Signs in with ACBL_MEMBER / ACBL_PASSWORD from .env. The session is kept in the profile.
async function signIn(page) {
  const { ACBL_MEMBER, ACBL_PASSWORD } = process.env;
  if (!ACBL_MEMBER || !ACBL_PASSWORD) return false;
  await page.waitForSelector('input[name="username"]', { timeout: 60000 });
  await page.fill('input[name="username"]', ACBL_MEMBER);
  await page.fill('input[name="password"]', ACBL_PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page.waitForURL((url) => !/login\.acbl\.org/.test(url.href), { timeout: 30000 }).catch(() => {});
  return !onLoginPage(page);
}

// Navigates to url, signing in first if ACBL redirects to its login page.
async function gotoAuthed(page, url) {
  await gotoPastCloudflare(page, url);
  if (onLoginPage(page) && await signIn(page)) await gotoPastCloudflare(page, url);
  if (onLoginPage(page)) {
    const err = new Error(process.env.ACBL_MEMBER
      ? 'ACBL sign-in failed – check ACBL_MEMBER / ACBL_PASSWORD in .env'
      : 'ACBL requires a login – add ACBL_MEMBER / ACBL_PASSWORD to .env');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }
}

// Expand every DataTable on the page to show all rows (the tables paginate client-side).
async function showAllRows(page) {
  await page.evaluate(() => {
    const DT = window.DataTable || (window.jQuery && window.jQuery.fn.dataTable);
    const api = DT && DT.tables && DT.tables({ api: true });
    if (api && api.page && api.page.len) {
      api.page.len(-1).draw(false);
      return;
    }
    // Older DataTables: pick the largest "Show N entries" option (-1 means all).
    for (const sel of document.querySelectorAll('select[name$="_length"]')) {
      const values = [...sel.options].map((o) => Number(o.value));
      sel.value = String(values.includes(-1) ? -1 : Math.max(...values));
      if (window.jQuery) window.jQuery(sel).trigger('change');
      else sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(300);
}

// ---------- Club results (my.acbl.org) ----------

async function scrapeClubList(page, clubId) {
  await gotoPastCloudflare(page, `${CLUB_BASE}/club-results/${clubId}`);
  await page.waitForSelector('a[href*="/club-results/details/"]', { timeout: 60000 });
  await showAllRows(page);
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('tr')]
      .map((tr) => {
        const link = tr.querySelector('a[href*="/club-results/details/"]');
        if (!link) return null;
        const c = [...tr.querySelectorAll('td')].map((td) => clean(td.innerText));
        return {
          id: link.getAttribute('href').split('/').pop(),
          date: c[0], event: c[1], type: c[2], rating: c[3], session: c[4], tables: Number(c[5]) || null
        };
      })
      .filter(Boolean);
  });
}

// Returns every pair row from every section/direction recap of one game.
async function scrapeGameDetails(page, gameId) {
  await gotoAuthed(page, `${CLUB_BASE}/club-results/details/${gameId}`);
  await page.waitForSelector('table caption', { timeout: 60000 });
  // Sections render lazily when their tab is clicked and then stay in the DOM,
  // so visit every tab first and read all recap tables once.
  const sectionIds = await page.$$eval('li[id^="section-"]', (lis) => lis.map((li) => li.id));
  for (const sectionId of sectionIds) {
    await page.click(`li#${sectionId} a`);
    await page.waitForTimeout(400);
  }
  await showAllRows(page);

  const rows = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const el of document.querySelectorAll('table')) {
      // Recap tables are captioned "Recaps ( Section A - NS )" (no direction for Howell movements).
      const m = clean(el.caption && el.caption.textContent).match(/^Recaps \( Section (\S+)(?: - (\S+))? \)$/);
      if (!m) continue;
      const pairs = [...el.querySelectorAll('tbody tr')].map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        if (tds.length < 6) return null;
        const txt = tds.map((td) => clean(td.innerText));
        // Layout: pair, names, strat, overall ranks (per strat), section ranks (per strat), score, %, mps
        const nRanks = (txt.length - 6) / 2;
        return {
          section: m[1],
          direction: m[2] || '',
          pair: txt[0],
          names: txt[1],
          players: [...tds[1].querySelectorAll('a')].map((a) => ({
            name: clean(a.textContent), playerId: (a.getAttribute('href') || '').split('/').pop()
          })),
          strat: txt[2],
          overall: txt.slice(3, 3 + nRanks),
          sectionRank: txt.slice(3 + nRanks, 3 + 2 * nRanks),
          score: parseFloat(txt[txt.length - 3]) || null,
          pct: parseFloat(txt[txt.length - 2]) || null,
          mps: txt[txt.length - 1]
        };
      }).filter(Boolean);
      pairs.forEach((p) => { p.fieldSize = pairs.length; });
      out.push(...pairs);
    }
    return out;
  });
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.section}|${r.direction}|${r.pair}`;
    return !seen.has(key) && seen.add(key);
  });
}

// ---------- Tournament results (live.acbl.org) ----------

// One row per session the player played, as listed on their ACBL Live results page.
async function scrapeLiveList(page, playerId) {
  await gotoAuthed(page, `${LIVE_BASE}/player-results/${playerId}`);
  await page.waitForSelector('a.summary', { timeout: 60000 });
  await showAllRows(page);
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('tr')]
      .map((tr) => {
        const link = tr.querySelector('a.summary');
        if (!link) return null;
        const td = tr.cells;
        const mpsCell = td[6];
        // A struck-through award has been replaced by a later one and doesn't count.
        const struck = !!mpsCell.querySelector('strike, s, del');
        const href = link.getAttribute('href');
        return {
          id: href.replace(/^\/event\//, '').replace(/\/summary$/, ''),
          date: clean(td[0].innerText),
          tournament: clean(td[1].innerText),
          event: clean(td[2].innerText),
          session: clean(td[3].innerText),
          pct: parseFloat(td[5].innerText) || null,
          // "*" marks a replaced award, "**" a side-series award; strip both before parsing.
          mps: parseFloat(mpsCell.innerText.replace(/\*/g, '')) || 0,
          mpsStruck: struck,
          // "Silver" or a per-color split like "Red 0.69 / Gold 2.23"
          color: [...td[7].innerText.split('\n')].map(clean).filter(Boolean).join(' / '),
          isTeams: !!tr.querySelector('a[class*="bracket"]') || !clean(td[5].innerText),
          summaryUrl: new URL(href, location.href).href
        };
      })
      .filter(Boolean);
  });
}

// Finds the player's row for one session: partner/teammates, flight, overall rank.
// The summary page usually has it; big NABC events only show leaderboards there,
// so fall back to the full recap page.
async function scrapeLiveSummary(page, url, playerName) {
  for (const pageUrl of [url, url.replace(/\/summary$/, '/recap')]) {
    await gotoAuthed(page, pageUrl);
    await page.waitForSelector('table', { timeout: 60000 }).catch(() => {});
    const found = await findPlayerRow(page, playerName);
    if (found) return found;
  }
  return null;
}

function findPlayerRow(page, playerName) {
  return page.evaluate((name) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const target = name.toLowerCase();
    const headOf = (t) => [...t.querySelectorAll('thead tr:first-child th')].map((th) => clean(th.innerText));
    // Any table listing players; prefer recaps (they have flight + overall rank) over leaderboards.
    const tables = [...document.querySelectorAll('table')]
      .filter((t) => headOf(t).includes('Player 1'))
      .sort((a, b) => headOf(b).includes('Flt') - headOf(a).includes('Flt'));
    for (const table of tables) {
      const head = headOf(table);
      const col = (label) => head.indexOf(label);
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.cells].map((td) => clean(td.innerText));
        const playerCols = head.map((h, i) => (/^Player \d$/.test(h) ? i : -1)).filter((i) => i >= 0);
        // Leaderboard cells read "Name City, ST" – keep the first line (the name).
        const players = playerCols
          .map((i) => tr.cells[i] && clean(tr.cells[i].innerText.split('\n')[0]))
          .filter(Boolean);
        if (!players.some((p) => p.toLowerCase() === target)) continue;
        const tableCount = (document.body.innerText.match(/([\d.]+)\s+TABLES/) || [])[1];
        return {
          others: players.filter((p) => p.toLowerCase() !== target),
          flight: col('Flt') >= 0 ? cells[col('Flt')] : '',
          overallRank: col('Overall') >= 0 ? cells[col('Overall')] : '',
          tables: tableCount ? Number(tableCount) : null
        };
      }
    }
    return null;
  }, playerName);
}

// ---------- Official masterpoint history (my.acbl.org, login required) ----------

// Every award on the member's masterpoint record, newest first, back to `since` (a Date).
// The page renders its table from a JSON endpoint (50 rows per page), so after loading the
// page once to get signed in, read that endpoint directly from inside the page.
async function scrapeMasterpointHistory(page, memberId, since) {
  await gotoAuthed(page, `${CLUB_BASE}/member/masterpoints-history?username=${memberId}`);
  const awards = [];
  for (let n = 1; n <= 100; n++) {
    const res = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: r.status, body: await r.text() };
    }, `/member/masterpoints-history/data?username=${memberId}&page=${n}`);
    if (res.status !== 200) throw new Error(`Masterpoint history page ${n} failed (HTTP ${res.status})`);
    const json = JSON.parse(res.body);
    const rows = json.data.map((a) => {
      const [y, m, d] = a.date.split('-');
      return {
        date: `${m}/${d}/${y}`,
        location: a.location,
        sanction: a.club_sanction,
        event: a.event_code_name,
        rating: a.event_rating_name,
        color: a.color,
        points: Number(a.points) || 0,
        pending: !!a.pending
      };
    });
    awards.push(...rows);
    if (!rows.length || n >= json.last_page) break;
    const [m, d, y] = rows[rows.length - 1].date.split('/').map(Number);
    if (new Date(y, m - 1, d) < since) break;
  }
  return awards;
}

module.exports = {
  openBrowser, gotoAuthed, showAllRows,
  scrapeClubList, scrapeGameDetails, scrapeLiveList, scrapeLiveSummary, scrapeMasterpointHistory
};
