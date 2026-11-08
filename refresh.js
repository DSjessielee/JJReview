// Scrapes ACBL into data/*.json. Used by the local server (Refresh button) and by publish.js.
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');
const {
  openBrowser, scrapeClubList, scrapeGameDetails, scrapeLiveList, scrapeLiveSummary, scrapeMasterpointHistory
} = require('./scraper');

const CLUB_ID = '259903';
const PLAYER_ID = '4594207';
const PLAYER_NAME = 'Jessie Lee';
// Results for recent games can still be corrected, so re-fetch anything this new.
const REFETCH_DAYS = 14;
// Only track games from this date onward.
const START_DATE = new Date(2024, 0, 1);
const DATA_DIR = path.join(__dirname, 'data');
const LOCK_FILE = path.join(DATA_DIR, '.refresh.lock');

// ACBL_MEMBER / ACBL_PASSWORD live in a local, git-ignored .env file; re-read on every refresh.
function loadEnv() {
  try {
    Object.assign(process.env, parseEnv(fs.readFileSync(path.join(__dirname, '.env'), 'utf8')));
  } catch {}
}

function parseDate(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split('/').map(Number);
  return new Date(y, m - 1, d);
}

function needsFetch(item) {
  return item.status !== 'ok' || (Date.now() - parseDate(item.date)) / 86400000 < REFETCH_DAYS;
}

// Each source: where it caches, how to list items, and how to fetch one item's details.
const SOURCES = {
  club: {
    file: path.join(DATA_DIR, `club-${CLUB_ID}.json`),
    list: (page) => scrapeClubList(page, CLUB_ID),
    keep: (g) => parseDate(g.date).getDay() === 5,
    fetch: async (page, game) => { game.rows = await scrapeGameDetails(page, game.id); }
  },
  live: {
    file: path.join(DATA_DIR, `live-${PLAYER_ID}.json`),
    list: (page) => scrapeLiveList(page, PLAYER_ID),
    keep: () => true,
    fetch: async (page, s) => {
      s.summary = await scrapeLiveSummary(page, s.summaryUrl, PLAYER_NAME);
      if (!s.summary) throw new Error(`${PLAYER_NAME} not found in the session results`);
    }
  },
  // ACBL's official masterpoint record: one row per award, nothing further to fetch per row.
  history: {
    file: path.join(DATA_DIR, `history-${PLAYER_ID}.json`),
    list: async (page) => (await scrapeMasterpointHistory(page, PLAYER_ID, START_DATE))
      .map((a, i) => ({ id: String(i), status: 'ok', ...a })),
    keep: () => true,
    fetch: null
  }
};

function loadData(source) {
  try {
    return JSON.parse(fs.readFileSync(SOURCES[source].file, 'utf8'));
  } catch {
    return { updatedAt: null, games: [] };
  }
}

function saveData(source, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SOURCES[source].file, JSON.stringify(data, null, 1));
}

// The server and the scheduled publish job share one Chrome profile, so only one
// refresh may run at a time across processes. A stale lock (dead pid) is ignored.
function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch {}
    }
  } catch {}
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Refreshes one source. `job` is updated in place so callers can report progress.
async function refresh(source, job = {}) {
  const src = SOURCES[source];
  Object.assign(job, { source, running: true, done: 0, total: 0, message: 'Loading list…', error: null });
  if (!acquireLock()) {
    Object.assign(job, { running: false, message: 'Failed', error: 'Another refresh is already running on this computer' });
    return job;
  }
  loadEnv();
  const data = loadData(source);
  const byId = new Map(data.games.map((g) => [g.id, g]));
  let ctx;
  try {
    ctx = await openBrowser();
    let page = ctx.pages()[0] || await ctx.newPage();

    const list = (await src.list(page)).filter((g) => parseDate(g.date) >= START_DATE && src.keep(g));
    // Sources without per-item pages (the history) are replaced wholesale each time.
    data.games = src.fetch ? list.map((g) => ({ ...byId.get(g.id), ...g })) : list;
    const todo = src.fetch ? data.games.filter(needsFetch) : [];
    job.total = todo.length;

    // Lists are newest first; if ACBL keeps refusing the login, stop hammering it.
    let loginStreak = 0;
    for (const item of todo) {
      job.message = `Fetching results for ${item.date}`;
      if (loginStreak >= 3) {
        item.status = 'login';
        job.done += 1;
        continue;
      }
      try {
        try {
          await src.fetch(page, item);
        } catch (err) {
          // Chrome occasionally dies on very large result pages; relaunch and retry once.
          if (!/has been closed|crashed/i.test(err.message)) throw err;
          await ctx.close().catch(() => {});
          ctx = await openBrowser();
          page = ctx.pages()[0] || await ctx.newPage();
          await src.fetch(page, item);
        }
        item.status = 'ok';
        delete item.statusMessage;
      } catch (err) {
        item.status = err.code === 'LOGIN_REQUIRED' ? 'login' : 'error';
        item.statusMessage = err.message;
      }
      loginStreak = item.status === 'login' ? loginStreak + 1 : 0;
      item.fetchedAt = new Date().toISOString();
      job.done += 1;
      data.updatedAt = new Date().toISOString();
      saveData(source, data);
    }
    data.updatedAt = new Date().toISOString();
    saveData(source, data);
    job.message = 'Done';
  } catch (err) {
    job.error = err.message;
    job.message = 'Failed';
  } finally {
    job.running = false;
    if (ctx) await ctx.close().catch(() => {});
    releaseLock();
  }
  return job;
}

module.exports = { SOURCES, PLAYER_NAME, loadData, refresh };
