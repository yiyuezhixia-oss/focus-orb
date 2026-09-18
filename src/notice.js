const elCard = document.getElementById('card');
const elTime = document.getElementById('n-time');
const elTitle = document.getElementById('n-title');
const elNote = document.getElementById('n-note');

let visible = false;

api.onNoticeData((d) => {
  elCard.classList.toggle('side-left', d.side === 'left');
  elTime.textContent = d.time || '00:00';
  elTitle.textContent = d.title || '专注';
  elNote.textContent = d.note || '';
  elCard.classList.add('show');
  visible = true;
});

api.onNoticeHide(() => {
  elCard.classList.remove('show');
  visible = false;
});
