const GUARDED = new Set([
  'explorer.exe', 'dwm.exe', 'winlogon.exe', 'csrss.exe', 'smss.exe', 'wininit.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'fontdrvhost.exe', 'ctfmon.exe', 'sihost.exe',
  'taskhostw.exe', 'runtimebroker.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
  'searchhost.exe', 'searchapp.exe', 'searchindexer.exe', 'applicationframehost.exe',
  'taskmgr.exe', 'conhost.exe', 'audiodg.exe', 'spoolsv.exe', 'wmiprvse.exe',
  'powershell.exe', 'cmd.exe', 'wsl.exe', 'node.exe', 'electron.exe',
  'focus orb.exe', 'focusorb.exe', 'focusorb-1.0.0.exe'
]);

const elList = document.getElementById('list');
const elState = document.getElementById('state');
const elCount = document.getElementById('count');
const elQ = document.getElementById('q');

let apps = [];
const selected = new Map();

const base = (p) => String(p || '').split('\\').pop().toLowerCase();

function render() {
  const q = elQ.value.trim().toLowerCase();
  const view = apps
    .filter((a) => !q || a.name.toLowerCase().includes(q) || String(a.path).toLowerCase().includes(q))
    .slice(0, 400);

  elList.innerHTML = '';
  if (!apps.length) {
    elState.textContent = '没有扫描到可用应用';
    elState.style.display = '';
    elList.appendChild(elState);
    return;
  }
  if (!view.length) {
    elState.textContent = '没有匹配的应用';
    elState.style.display = '';
    elList.appendChild(elState);
    return;
  }
  elState.style.display = 'none';

  view.forEach((a) => {
    const on = selected.has(a.path);
    const item = document.createElement('div');
    item.className = 'item' + (on ? ' on' : '');

    const box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2.5 6.2l2.4 2.4L9.6 3.9" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = a.name;
    const pa = document.createElement('div');
    pa.className = 'path';
    pa.textContent = a.path;
    info.appendChild(nm);
    info.appendChild(pa);

    item.appendChild(box);
    item.appendChild(info);
    item.addEventListener('click', () => {
      if (selected.has(a.path)) selected.delete(a.path);
      else selected.set(a.path, { name: a.name, path: a.path });
      item.classList.toggle('on', selected.has(a.path));
      elCount.textContent = `已选 ${selected.size} 个`;
    });

    elList.appendChild(item);
  });
}

async function load() {
  let raw = [];
  try {
    raw = await api.scanApps();
  } catch (e) {
    raw = [];
  }
  apps = (Array.isArray(raw) ? raw : [])
    .filter((a) => a && a.path && a.name)
    .filter((a) => !GUARDED.has(base(a.path)))
    .filter((a) => !String(a.path).toLowerCase().includes('\\windowsapps\\'));

  render();
  elCount.textContent = `已选 ${selected.size} 个`;
}

api.onAppsInit((list) => {
  (list || []).forEach((a) => {
    if (a && a.path) selected.set(a.path, { name: a.name, path: a.path });
  });
  elCount.textContent = `已选 ${selected.size} 个`;
  if (apps.length) render();
});

elQ.addEventListener('input', render);
document.getElementById('btn-cancel').addEventListener('click', () => api.appsCancel());
document.getElementById('btn-close').addEventListener('click', () => api.appsCancel());
document.getElementById('btn-ok').addEventListener('click', () => api.appsConfirm([...selected.values()]));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.appsCancel();
  if (e.key === 'Enter') api.appsConfirm([...selected.values()]);
});

api.appsReady();
load();
