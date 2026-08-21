const AVATARS = ['🙂', '😎', '🦊', '🐼', '🐧', '🦁', '🐸', '🐵', '🐶', '🐱', '🦄', '🐙', '🌟', '🔥'];

export function initAvatarPicker(containerEl, onSelect) {
  containerEl.innerHTML = '';
  let selected = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  AVATARS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-option';
    btn.textContent = emoji;
    btn.dataset.selected = String(emoji === selected);
    btn.addEventListener('click', () => {
      containerEl.querySelectorAll('.avatar-option').forEach((el) => (el.dataset.selected = 'false'));
      btn.dataset.selected = 'true';
      selected = emoji;
      onSelect(emoji);
    });
    containerEl.appendChild(btn);
  });
  onSelect(selected);
  return () => selected;
}

const micIconSvg = (muted) =>
  muted
    ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 11h-2a5 5 0 01-.24 1.52l1.46 1.46A6.97 6.97 0 0019 11zM4.27 3L3 4.27l6 6V11a3 3 0 003 3c.16 0 .31-.02.46-.05l1.06 1.06A4.98 4.98 0 0112 15a5 5 0 01-5-5H5a7 7 0 006 6.92V21h2v-3.08c.91-.13 1.76-.45 2.5-.93L19.73 21 21 19.73 4.27 3zM15 11a3 3 0 00-3-3v.18l2.97 2.97c.02-.05.03-.1.03-.15z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z"/></svg>';

export function renderParticipants(listEl, countEl, participants, selfId, onVolumeChange) {
  countEl.textContent = String(participants.size);
  const existingIds = new Set([...listEl.children].map((el) => el.dataset.id));
  const currentIds = new Set(participants.keys());

  // remove quem saiu, com animação
  existingIds.forEach((id) => {
    if (!currentIds.has(id)) {
      const el = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 220);
      }
    }
  });

  participants.forEach((p, id) => {
    let row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) {
      row = document.createElement('li');
      row.className = 'participant-row';
      row.dataset.id = id;
      row.innerHTML = `
        <div class="p-avatar" data-speaking="false"></div>
        <div class="p-info">
          <div class="p-name"></div>
          <div class="p-meta"><span class="p-mic"></span><span class="p-share-label"></span></div>
        </div>
      `;
      if (id !== selfId) {
        const vol = document.createElement('input');
        vol.type = 'range';
        vol.min = '0';
        vol.max = '2';
        vol.step = '0.1';
        vol.value = '1';
        vol.className = 'p-volume';
        vol.title = 'Volume';
        vol.addEventListener('input', () => onVolumeChange(id, parseFloat(vol.value)));
        row.appendChild(vol);
      }
      listEl.appendChild(row);
    }
    row.querySelector('.p-avatar').textContent = p.avatar;
    row.querySelector('.p-avatar').dataset.speaking = String(!!p.speaking);
    row.querySelector('.p-name').textContent = p.name + (id === selfId ? ' (você)' : '');
    row.querySelector('.p-mic').innerHTML = micIconSvg(p.muted);
    row.querySelector('.p-share-label').textContent = p.sharingScreen ? '· compartilhando tela' : '';
  });
}

export function renderSpeakerGrid(gridEl, participants, selfId, activeShareId) {
  const currentIds = new Set([...gridEl.children].map((el) => el.dataset.id));
  const wantedIds = new Set([...participants.keys()].filter((id) => id !== activeShareId));

  currentIds.forEach((id) => {
    if (!wantedIds.has(id)) gridEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
  });

  participants.forEach((p, id) => {
    if (id === activeShareId) return;
    let tile = gridEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'speaker-tile';
      tile.dataset.id = id;
      tile.innerHTML = `
        <span class="speaker-tile-mic"></span>
        <div class="speaker-tile-avatar" data-speaking="false"></div>
        <div class="speaker-tile-name"></div>
      `;
      gridEl.appendChild(tile);
    }
    tile.querySelector('.speaker-tile-avatar').textContent = p.avatar;
    tile.querySelector('.speaker-tile-avatar').dataset.speaking = String(!!p.speaking);
    tile.querySelector('.speaker-tile-name').textContent = id === selfId ? `${p.name} (você)` : p.name;
    tile.querySelector('.speaker-tile-mic').innerHTML = micIconSvg(p.muted);
    tile.querySelector('.speaker-tile-mic').dataset.muted = String(p.muted);
  });
}

export function showToast(container, message, tone = 'default', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export function setConnectionStatus(el, state, label) {
  el.dataset.state = state;
  el.querySelector('.status-text').textContent = label;
}
