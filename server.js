// Local site with live Refresh buttons: npm start, then open http://localhost:3000
const path = require('path');
const express = require('express');
const { SOURCES, loadData, refresh } = require('./refresh');

const PORT = process.env.PORT || 3000;

let job = { source: null, running: false, done: 0, total: 0, message: 'Idle', error: null };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/:source', (req, res, next) => {
  if (!SOURCES[req.params.source]) return next();
  res.json(loadData(req.params.source));
});
app.get('/api/refresh/status', (_req, res) => res.json(job));
app.post('/api/:source/refresh', (req, res, next) => {
  if (!SOURCES[req.params.source]) return next();
  if (job.running && job.source !== req.params.source) {
    return res.status(409).json({ ...job, error: `A ${job.source} refresh is already running` });
  }
  if (!job.running) {
    const current = job = {};
    // The ACBL tab's Refresh also updates the official masterpoint history (its color card).
    refresh(req.params.source, current).then(() => {
      if (req.params.source === 'live' && !current.error) refresh('history', current);
    });
  }
  res.json(job);
});

app.listen(PORT, () => console.log(`JJReview running at http://localhost:${PORT}`));
