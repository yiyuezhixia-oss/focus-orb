const CIRC = 2 * Math.PI * 52;

const elOrb = document.getElementById('orb');
const elTime = document.getElementById('time');
const elMeta = document.getElementById('meta');
const elProg = document.getElementById('prog');

let session = null;
let total = 0;
let remainMs = 0;
let endsAt = 0;
let paused = false;
let done = false;
let points = [];
let fired = new Set();
let timer = null;

function fmt(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function buildPoints() {
  points = [];
  (session.reminders || []).forEach((r, ri) => {
    if (r.kind === 'interval') {
      const step = r.value * 60000;
      for (let at = step; at < total; at += step) points.push({ id: `${ri}-${at}`, at });
    } else {
      const at = total - r.value * 60000;
      if (at > 0 && at < total) points.push({ id: `${ri}`, at });
    }
  });
  points.sort((a, b) => a.at - b.at);
}

function render() {
  const ratio = total > 0 ? Math.max(0, Math.min(1, remainMs / total)) : 0;
  elProg.style.strokeDashoffset = String(CIRC * (1 - ratio));
  elTime.textContent = fmt(remainMs);
  elOrb.classList.toggle('paused', paused);
  elOrb.classList.toggle('done', done);
  elOrb.classList.toggle('urgent', !done && !paused && remainMs > 0 && remainMs <= 60000);

  if (done) elMeta.textContent = '已完成';
  else if (paused) elMeta.textContent = '已暂停';
  else elMeta.textContent = session ? session.title : '专注';
}

function checkReminders() {
  if (done || paused) return;
  const elapsed = total - remainMs;
  for (const p of points) {
    if (!fired.has(p.id) && elapsed >= p.at) {
      fired.add(p.id);
      fire();
    }
  }
}

function fire() {
  api.showNotice({
    time: fmt(remainMs),
    title: session ? session.title : '专注',
    note: session ? session.note : ''
  });
}

function finish() {
  done = true;
  remainMs = 0;
  render();
  api.sessionFinished();
  api.showNotice({
    time: '00:00',
    title: session ? session.title : '专注',
    note: session ? session.note : '',
    finished: true
  });
  stopTimer();
}

function tick() {
  if (!paused && !done) {
    remainMs = endsAt - Date.now();
    if (remainMs <= 0) {
      remainMs = 0;
      render();
      finish();
      return;
    }
  }
  render();
  checkReminders();
}

function startTimer() {
  stopTimer();
  timer = setInterval(tick, 200);
  tick();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function start(cfg) {
  session = cfg;
  document.documentElement.style.setProperty('--size', (cfg.orbSize || 96) + 'px');
  total = Math.max(1, cfg.durationMin) * 60000;
  remainMs = total;
  endsAt = Date.now() + total;
  paused = false;
  done = false;
  fired = new Set();
  buildPoints();
  render();
  startTimer();
  report();
}

function setPaused(v) {
  if (done) return;
  if (v === paused) return;
  paused = v;
  if (paused) {
    remainMs = Math.max(0, endsAt - Date.now());
    stopTimer();
  } else {
    endsAt = Date.now() + remainMs;
    startTimer();
  }
  render();
  report();
}

function report() {
  api.orbState({ paused, done });
}

/* 拖动 / 点击 */
let dragging = false;
let moved = false;
let clickTimer = null;

elOrb.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  document.body.classList.add('dragging');
  try { elOrb.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  api.orbDragStart();
});

elOrb.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (!moved) {
    moved = true;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  }
  api.orbDragMove();
});

elOrb.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  try { elOrb.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  api.orbDragEnd();

  if (!moved) {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (done) api.openSetup();
      else setPaused(!paused);
    }, 220);
  }
});

elOrb.addEventListener('dblclick', () => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  api.openSetup();
});

elOrb.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.orbMenu({ paused, done });
});

const elToggle = document.getElementById('btn-toggle');
const elStop = document.getElementById('btn-stop');

[elToggle, elStop].forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn === elToggle) {
      if (!done) setPaused(!paused);
      else api.openSetup();
    } else {
      api.endSession();
    }
  });
});

api.onSessionData((cfg) => start(cfg));

api.onOrbCommand((cmd) => {
  if (cmd === 'pause') setPaused(true);
  else if (cmd === 'resume') setPaused(false);
  else if (cmd === 'restart') {
    if (session) start(session);
  } else if (cmd === 'stop') {
    api.endSession();
  }
});

api.orbReady();
