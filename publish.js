// Refreshes ACBL data, builds the read-only site into dist/, and pushes it to the
// gh-pages branch that GitHub Pages serves. Run weekly by Windows Task Scheduler.
//   node publish.js                 refresh + build + push
//   node publish.js --skip-refresh  build + push from the data already on disk
//   node publish.js --no-push       refresh + build only (preview dist/ locally)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadData, refresh, PLAYER_NAME } = require('./refresh');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(ROOT, 'data', 'publish.log');
const args = new Set(process.argv.slice(2));

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, line + '\n');
}

// Club recaps list every pair in the game, and ACBL keeps older games behind its login,
// so the public copy keeps only Jessie's row. Other pairs stay as anonymous
// direction + % so her place in the field can still be computed.
function slimClub(data) {
  const target = PLAYER_NAME.toLowerCase();
  const isPlayer = (r) => r.players.some((p) => p.name.toLowerCase() === target) || r.names.toLowerCase().includes(target);
  return {
    updatedAt: data.updatedAt,
    games: data.games
      .filter((g) => g.status === 'ok' && g.rows)
      .map(({ id, date, event, type, rating, session, tables, status, rows }) => ({
        id, date, event, type, rating, session, tables, status,
        rows: rows.map((r) => (isPlayer(r) ? r : { direction: r.direction, pct: r.pct, players: [], names: '' }))
      }))
  };
}

function slimLive(data) {
  return {
    updatedAt: data.updatedAt,
    games: data.games.filter((g) => g.status === 'ok').map(({ statusMessage, fetchedAt, ...g }) => g)
  };
}

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'mode.js'), 'window.JJ_STATIC = true;\n');
  // GitHub Pages lets browsers cache files for ~10 minutes; version the asset URLs so a
  // fresh page never runs with a stale app.js / styles.css.
  const version = Date.now().toString(36);
  const indexFile = path.join(DIST, 'index.html');
  fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8')
    .replace(/(href|src)="(styles\.css|mode\.js|app\.js)"/g, `$1="$2?v=${version}"`));
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  fs.mkdirSync(path.join(DIST, 'data'));
  fs.writeFileSync(path.join(DIST, 'data', 'club.json'), JSON.stringify(slimClub(loadData('club'))));
  fs.writeFileSync(path.join(DIST, 'data', 'live.json'), JSON.stringify(slimLive(loadData('live'))));
  fs.writeFileSync(path.join(DIST, 'data', 'history.json'), JSON.stringify(loadData('history')));
}

// dist/ becomes its own one-commit repo, force-pushed to gh-pages: the branch only ever
// holds the latest site, so weekly data updates don't pile up history.
function push() {
  const git = (...a) => execFileSync('git', a, { cwd: DIST, stdio: 'pipe' }).toString().trim();
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT }).toString().trim();
  git('init', '-q', '-b', 'gh-pages');
  git('add', '-A');
  git('-c', 'user.name=JJReview', 'commit', '-q', '-m', `Publish site data ${new Date().toISOString().slice(0, 10)}`);
  git('push', '-q', '--force', remote, 'gh-pages');
}

(async () => {
  try {
    if (!args.has('--skip-refresh')) {
      for (const source of ['club', 'live', 'history']) {
        log(`Refreshing ${source}…`);
        const job = await refresh(source);
        if (job.error) throw new Error(`${source} refresh failed: ${job.error}`);
        log(`Refreshed ${source}: ${job.done} results fetched`);
      }
    }
    build();
    log('Built dist/');
    if (!args.has('--no-push')) {
      push();
      log('Pushed to gh-pages');
    }
  } catch (err) {
    log(`ERROR ${err.message}`);
    process.exitCode = 1;
  }
})();
