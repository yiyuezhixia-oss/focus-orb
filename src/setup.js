const DURATION_PRESETS = [15, 25, 45, 60, 90];
const SIZE_PRESETS = [
  { label: '小', value: 80 },
  { label: '标准', value: 96 },
  { label: '大', value: 120 }
];

const state = {
  title: '',
  note: '',
  duration: 25,
  size: 96,
  reminders: [],
  blockedApps: []
};

const $ = (id) => document.getElementById(id);
const elTitle = $('f-title');
const elNote = $('f-note');
const elDuration = $('f-duration');
const elInterval = $('f-interval');
const elCountdown = $('f-countdown');
const elChips = $('duration-chips');
const elSizeChips = $('size-chips');
const elList = $('rlist');
const elEmpty = $('rempty');
const elPreview = $('rpreview');
const elBlist = $('blist');
const elBempty = $('bempty');
const elTotal = $('total-preview');

let uid = 0;

function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function totalMs() {
  return state.duration * 60000;
}

function reminderPoints() {
  const total = totalMs();
  const pts = [];
  state.reminders.forEach((r) => {
    if (r.kind === 'interval') {
      const step = r.value * 60000;
      for (let at = step; at < total; at += step) pts.push(at);
    } else {
      const at = total - r.value * 60000;
      if (at > 0 && at < total) pts.push(at);
    }
  });
  return [...new Set(pts)].sort((a, b) => b - a);
}

function renderChips() {
  elChips.innerHTML = '';
  DURATION_PRESETS.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (v === state.duration ? ' active' : '');
    b.textContent = v;
    b.addEventListener('click', () => setDuration(v));
    elChips.appendChild(b);
  });
}

function renderSizeChips() {
  elSizeChips.innerHTML = '';
  SIZE_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (p.value === state.size ? ' active' : '');
    b.textContent = p.label;
    b.addEventListener('click', () => {
      state.size = p.value;
      renderSizeChips();
    });
    elSizeChips.appendChild(b);
  });
}

function renderBlocked() {
  elBlist.innerHTML = '';
  state.blockedApps.forEach((a, i) => {
    const item = document.createElement('span');
    item.className = 'ritem';
    item.textContent = a.name || a.path;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rm';
    btn.textContent = 'x';
    btn.title = '移除';
    btn.addEventListener('click', () => {
      state.blockedApps.splice(i, 1);
      renderBlocked();
    });
    item.appendChild(btn);
    elBlist.appendChild(item);
  });
  elBempty.classList.toggle('hidden', state.blockedApps.length > 0);
}

function setDuration(v) {
  const n = Math.max(1, Math.min(600, Math.round(Number(v) || 1)));
  state.duration = n;
  elDuration.value = n;
  renderChips();
  renderReminders();
}

function renderReminders() {
  elList.innerHTML = '';
  state.reminders.forEach((r) => {
    const item = document.createElement('span');
    item.className = 'ritem';
    item.textContent = r.kind === 'interval' ? `每 ${r.value} 分钟` : `倒数第 ${r.value} 分钟`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rm';
    btn.textContent = 'x';
    btn.title = '移除';
    btn.addEventListener('click', () => {
      state.reminders = state.reminders.filter((x) => x.id !== r.id);
      renderReminders();
    });
    item.appendChild(btn);
    elList.appendChild(item);
  });

  elEmpty.classList.toggle('hidden', state.reminders.length > 0);

  const pts = reminderPoints();
  if (!pts.length) {
    elPreview.textContent = '';
  } else {
    const list = pts.map((at) => fmtClock(totalMs() - at)).join('  ·  ');
    elPreview.textContent = `剩余 ${list} 时提醒`;
  }

  elTotal.textContent = `${state.duration} 分钟`;
}

function addReminder(kind) {
  const input = kind === 'interval' ? elInterval : elCountdown;
  const v = Math.round(Number(input.value));
  if (!Number.isFinite(v) || v < 1) {
    flash(input);
    return;
  }
  if (v >= state.duration) {
    flash(input);
    return;
  }
  const dup = state.reminders.some((r) => r.kind === kind && r.value === v);
  if (dup) {
    flash(input);
    return;
  }
  state.reminders.push({ id: ++uid, kind, value: v });
  renderReminders();
}

function flash(el) {
  el.style.transition = 'none';
  el.style.borderColor = 'rgba(255,107,91,.9)';
  el.focus();
  setTimeout(() => {
    el.style.transition = 'border-color .5s';
    el.style.borderColor = '';
  }, 60);
}

function start() {
  const title = elTitle.value.trim() || '专注';
  const note = elNote.value.trim();
  const duration = Math.max(1, Math.min(600, Math.round(Number(elDuration.value) || 25)));
  api.startSession({
    title,
    note,
    durationMin: duration,
    orbSize: state.size,
    reminders: state.reminders.map((r) => ({ kind: r.kind, value: r.value })),
    blockedApps: state.blockedApps.map((a) => ({ name: a.name, path: a.path }))
  });
}

/* 事件绑定 */
elDuration.addEventListener('change', () => setDuration(elDuration.value));
elDuration.addEventListener('input', () => {
  const n = Math.round(Number(elDuration.value));
  if (Number.isFinite(n) && n >= 1 && n <= 600) {
    state.duration = n;
    renderChips();
    renderReminders();
  }
});

$('dur-minus').addEventListener('click', () => setDuration(state.duration - (state.duration > 30 ? 5 : 1)));
$('dur-plus').addEventListener('click', () => setDuration(state.duration + (state.duration >= 30 ? 5 : 1)));
$('btn-pick').addEventListener('click', () => api.openApps(state.blockedApps));
api.onAppsSelected((list) => {
  state.blockedApps = Array.isArray(list) ? list : [];
  renderBlocked();
});
$('add-interval').addEventListener('click', () => addReminder('interval'));
$('add-countdown').addEventListener('click', () => addReminder('countdown'));
$('btn-start').addEventListener('click', start);
$('btn-min').addEventListener('click', () => api.minimize());
$('btn-close').addEventListener('click', () => api.closeWindow());

[elInterval, elCountdown].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addReminder(el === elInterval ? 'interval' : 'countdown');
    }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
});

/* 初始化：读取上次配置 */
(async () => {
  renderChips();
  renderSizeChips();
  renderReminders();
  renderBlocked();
  try {
    const initial = await api.getInitial();
    const last = initial && initial.last;
    if (last) {
      elTitle.value = last.title && last.title !== '专注' ? last.title : '';
      elNote.value = last.note || '';
      if ([80, 96, 120].includes(last.orbSize)) {
        state.size = last.orbSize;
        renderSizeChips();
      }
      setDuration(last.durationMin || 25);
      state.reminders = (last.reminders || []).map((r) => ({ id: ++uid, kind: r.kind, value: r.value }));
      state.blockedApps = (last.blockedApps || []).filter((a) => a && a.path);
      renderReminders();
      renderBlocked();
    }
  } catch (e) { /* 读取失败保持默认 */ }
})();
