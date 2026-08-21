import { SignalingClient } from './socket-client.js';
import { WebRTCManager } from './webrtc-manager.js';
import { MediaManager } from './media-manager.js';
import { VoiceActivityDetector } from './audio-vad.js';
import * as UI from './ui.js';

// ---------------------------------------------------------------------------
// Referências DOM
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);

const viewLanding = el('view-landing');
const viewRoom = el('view-room');

const inputName = el('input-name');
const avatarPicker = el('avatar-picker');
const btnCreateRoom = el('btn-create-room');
const inputRoomCode = el('input-room-code');
const btnJoinRoom = el('btn-join-room');
const lobbyError = el('lobby-error');

const roomIdLabel = el('room-id-label');
const connectionStatusEl = el('connection-status');
const btnCopyLink = el('btn-copy-link');
const toastContainer = el('toast-container');

const participantsList = el('participants-list');
const participantsCount = el('participants-count');
const participantsPanel = el('participants-panel');
const participantsScrim = el('participants-scrim');
const btnToggleParticipants = el('btn-toggle-participants');
const btnCloseParticipants = el('btn-close-participants');

const stageEmpty = el('stage-empty');
const screenShareView = el('screen-share-view');
const screenShareVideo = el('screen-share-video');
const screenShareOwnerName = el('screen-share-owner-name');
const qualityBadge = el('quality-badge');
const btnFullscreen = el('btn-fullscreen');
const speakerGrid = el('speaker-grid');

const btnMic = el('btn-mic');
const btnScreenShare = el('btn-screen-share');
const btnDevices = el('btn-devices');
const btnLeave = el('btn-leave');
const devicesPanel = el('devices-panel');
const selectMic = el('select-mic');
const selectSpeaker = el('select-speaker');
const selectQuality = el('select-quality');
const selectFps = el('select-fps');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let selfName = '';
let selfAvatar = '🙂';
let roomId = null;

let signaling = null;
const media = new MediaManager();
let webrtc = null;
const vad = new VoiceActivityDetector({ threshold: 0.018, holdMs: 400 });
let isEnteringRoom = false;
let mediaEventsBound = false;

/** @type {Map<string, {id:string,name:string,avatar:string,muted:boolean,speaking:boolean,sharingScreen:boolean}>} */
const participants = new Map();

let activeShareId = null; // quem está com a tela em destaque no palco
const shareVideoTracks = new Map(); // peerId -> MediaStreamTrack (video)

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
UI.initAvatarPicker(avatarPicker, (emoji) => (selfAvatar = emoji));

function currentPathRoomId() {
  const m = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{4,12})$/);
  return m ? m[1] : null;
}

function setLobbyError(msg) {
  lobbyError.textContent = msg || '';
}

btnCreateRoom.addEventListener('click', async () => {
  setLobbyError('');
  const name = inputName.value.trim();
  if (!name) return setLobbyError('Digite um nome para continuar.');
  btnCreateRoom.disabled = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error();
    const { roomId: newRoomId } = await res.json();
    await enterRoom(newRoomId, name, selfAvatar);
  } catch (err) {
    console.error('[ChatPatty] falha ao criar sala:', err);
    setLobbyError(err?.message || 'Não foi possível criar a sala. Tente novamente.');
  } finally {
    btnCreateRoom.disabled = false;
  }
});

btnJoinRoom.addEventListener('click', async () => {
  setLobbyError('');
  const name = inputName.value.trim();
  const code = inputRoomCode.value.trim();
  if (!name) return setLobbyError('Digite um nome para continuar.');
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) return setLobbyError('Código de sala inválido.');
  btnJoinRoom.disabled = true;
  try {
    await enterRoom(code, name, selfAvatar);
  } catch (err) {
    setLobbyError(err.message || 'Não foi possível entrar na sala.');
  } finally {
    btnJoinRoom.disabled = false;
  }
});

inputRoomCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoinRoom.click();
});
inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && inputRoomCode.value.trim()) btnJoinRoom.click();
  else if (e.key === 'Enter') btnCreateRoom.click();
});

// Se a URL já aponta para uma sala, pré-preenche o código
const prefillRoomId = currentPathRoomId();
if (prefillRoomId) inputRoomCode.value = prefillRoomId;

// ---------------------------------------------------------------------------
// Entrar na sala
// ---------------------------------------------------------------------------
async function enterRoom(id, name, avatar) {
  // Evita que cliques repetidos (ou uma tentativa lenta ainda em curso)
  // disparem múltiplas conexões simultâneas — essa acumulação era a causa
  // dos eventos e toasts duplicados, e de o app ficar preso na tela inicial.
  if (isEnteringRoom) return;
  isEnteringRoom = true;

  try {
    selfName = name;
    selfAvatar = avatar;
    roomId = id;

    // Se restou uma conexão de uma tentativa anterior mal-sucedida, encerra
    // antes de abrir outra.
    if (signaling) {
      signaling.leaveRoom();
      signaling.disconnect();
    }

    if (!media.micTrack) {
      try {
        await media.initMic();
      } catch (err) {
        throw new Error('Não foi possível acessar o microfone. Verifique as permissões do navegador.');
      }
    }

    signaling = new SignalingClient();
    try {
      await signaling.connect();
    } catch (err) {
      throw new Error('Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.');
    }
    wireSignalingEvents();

    const joinRes = await signaling.joinRoom({ roomId: id, name, avatar });

    window.history.pushState({}, '', `/room/${id}`);

    webrtc = new WebRTCManager(signaling, joinRes.selfId, joinRes.iceServers);
    wireWebrtcEvents();

    // registra a si mesmo e os usuários que já estavam na sala
    participants.set(joinRes.selfId, {
      id: joinRes.selfId,
      name,
      avatar,
      muted: true,
      speaking: false,
      sharingScreen: false,
    });
    joinRes.users.forEach((u) => {
      participants.set(u.id, { ...u, speaking: false });
      webrtc.addPeer(u.id);
    });

    webrtc.setLocalMicTrack(media.micTrack);
    vad.start(media.micTrack);
    if (!mediaEventsBound) {
      mediaEventsBound = true;
      vad.on('change', (speaking) => {
        if (!webrtc) return;
        updateParticipant(webrtc.selfId, { speaking });
        signaling.setSpeaking(speaking);
      });
      media.on('screen-share-ended-natively', () => stopScreenShare());
    }

    viewLanding.hidden = true;
    viewRoom.hidden = false;
    roomIdLabel.textContent = id;
    UI.setConnectionStatus(connectionStatusEl, 'connected', 'conectado');

    renderAll();
    await populateDevicePickers();
    startAdaptiveQualityLoop();
  } catch (err) {
    console.error('[ChatPatty] falha ao entrar na sala:', err);
    signaling?.disconnect();
    signaling = null;
    throw err;
  } finally {
    isEnteringRoom = false;
  }
}

function wireSignalingEvents() {
  signaling.on('disconnect', () => UI.setConnectionStatus(connectionStatusEl, 'reconnecting', 'reconectando…'));
  signaling.on('reconnecting', () => UI.setConnectionStatus(connectionStatusEl, 'reconnecting', 'reconectando…'));
  signaling.on('reconnected', () => {
    UI.setConnectionStatus(connectionStatusEl, 'connected', 'conectado');
    UI.showToast(toastContainer, 'Conexão restabelecida', 'success');
  });

  signaling.on('user-joined', (u) => {
    participants.set(u.id, { ...u, speaking: false });
    webrtc.addPeer(u.id);
    renderAll();
    UI.showToast(toastContainer, `${u.name} entrou na sala`);
  });

  signaling.on('user-left', ({ id }) => {
    const p = participants.get(id);
    webrtc.removePeer(id);
    media.detachRemoteAudio(id);
    shareVideoTracks.delete(id);
    participants.delete(id);
    if (activeShareId === id) clearScreenShareView();
    renderAll();
    if (p) UI.showToast(toastContainer, `${p.name} saiu da sala`);
  });

  signaling.on('user-mic-state', ({ id, muted }) => updateParticipant(id, { muted }));
  signaling.on('user-speaking-state', ({ id, speaking }) => updateParticipant(id, { speaking }));
  signaling.on('user-screen-share-state', ({ id, sharing }) => {
    updateParticipant(id, { sharingScreen: sharing });
    if (!sharing && activeShareId === id) clearScreenShareView();
    if (sharing && !activeShareId) activeShareId = id;
    renderAll();
  });
}

function wireWebrtcEvents() {
  webrtc.on('remote-track', ({ peerId, track }) => {
    if (track.kind === 'audio') {
      media.attachRemoteAudioTrack(peerId, track);
    } else if (track.kind === 'video') {
      shareVideoTracks.set(peerId, track);
      if (!activeShareId) activeShareId = peerId;
      if (activeShareId === peerId) showScreenShareView(peerId, track);
      track.addEventListener('ended', () => {
        shareVideoTracks.delete(peerId);
        if (activeShareId === peerId) clearScreenShareView();
      });
      renderAll();
    }
  });

  webrtc.on('peer-connection-state', ({ peerId, state }) => {
    if (state === 'failed') {
      UI.showToast(toastContainer, 'Problema de conexão com um participante — tentando reconectar…', 'error');
    }
  });
}

function updateParticipant(id, patch) {
  const p = participants.get(id);
  if (!p) return;
  Object.assign(p, patch);
  renderAll();
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
function renderAll() {
  UI.renderParticipants(participantsList, participantsCount, participants, webrtc?.selfId, (peerId, vol) =>
    media.setRemoteVolume(peerId, vol)
  );
  UI.renderSpeakerGrid(speakerGrid, participants, webrtc?.selfId, activeShareId);
}

function showScreenShareView(peerId, track) {
  const stream = new MediaStream([track]);
  screenShareVideo.srcObject = stream;
  const p = participants.get(peerId);
  screenShareOwnerName.textContent = peerId === webrtc.selfId ? 'Você' : p?.name || 'Participante';
  stageEmpty.hidden = true;
  screenShareView.hidden = false;
}

function clearScreenShareView() {
  activeShareId = null;
  screenShareVideo.srcObject = null;
  screenShareView.hidden = true;
  const next = [...shareVideoTracks.entries()][0];
  if (next) {
    activeShareId = next[0];
    showScreenShareView(next[0], next[1]);
  } else {
    stageEmpty.hidden = false;
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Controles: microfone
// ---------------------------------------------------------------------------
btnMic.addEventListener('click', () => {
  const next = !media.isMicEnabled();
  media.setMicEnabled(next);
  btnMic.dataset.active = String(next);
  btnMic.title = next ? 'Desativar microfone' : 'Ativar microfone';
  updateParticipant(webrtc.selfId, { muted: !next });
  signaling.setMicState(!next);
  if (!next) vad.emit('change', false);
});

// ---------------------------------------------------------------------------
// Controles: compartilhar tela
// ---------------------------------------------------------------------------
btnScreenShare.addEventListener('click', async () => {
  if (media.isSharingScreen()) {
    stopScreenShare();
    return;
  }
  media.qualityPreference = selectQuality.value;
  media.fpsPreference = parseInt(selectFps.value, 10);
  try {
    const tracks = await media.startScreenShare();
    webrtc.addLocalScreenTracks(tracks);
    btnScreenShare.dataset.active = 'true';
    signaling.setScreenShareState(true);
    updateParticipant(webrtc.selfId, { sharingScreen: true });
    activeShareId = webrtc.selfId;
    showScreenShareView(webrtc.selfId, media.screenVideoTrack);
    renderAll();
    UI.showToast(toastContainer, 'Você começou a compartilhar sua tela', 'success');
  } catch (err) {
    if (err?.name !== 'NotAllowedError') {
      UI.showToast(toastContainer, 'Não foi possível iniciar o compartilhamento de tela.', 'error');
    }
  }
});

function stopScreenShare() {
  if (!media.isSharingScreen()) return;
  webrtc.removeLocalScreenTracks();
  media.stopScreenShare();
  btnScreenShare.dataset.active = 'false';
  signaling.setScreenShareState(false);
  updateParticipant(webrtc.selfId, { sharingScreen: false });
  if (activeShareId === webrtc.selfId) clearScreenShareView();
  UI.showToast(toastContainer, 'Compartilhamento de tela encerrado');
}

// ---------------------------------------------------------------------------
// Adaptação automática de qualidade (bitrate/resolução conforme a rede)
// ---------------------------------------------------------------------------
let adaptiveQualityIntervalId = null;

function startAdaptiveQualityLoop() {
  if (adaptiveQualityIntervalId) clearInterval(adaptiveQualityIntervalId);

  webrtc.on('stats', ({ lossRatio, rtt }) => {
    if (!media.isSharingScreen()) return;
    if (selectQuality.value !== 'auto') return;

    const width = media.screenVideoTrack?.getSettings().width || 1280;
    let kbps = media.bitrateForWidth(width);

    if (lossRatio > 0.08 || (rtt && rtt > 0.35)) {
      kbps = Math.round(kbps * 0.6);
      webrtc.setScreenDownscale(1.5);
      qualityBadge.textContent = 'ajustando…';
    } else {
      webrtc.setScreenDownscale(1);
      qualityBadge.textContent = `${media.screenVideoTrack?.getSettings().height || ''}p`;
    }
    webrtc.setScreenMaxBitrate(kbps);
  });

  adaptiveQualityIntervalId = setInterval(() => {
    if (media.isSharingScreen() && screenShareView.hidden === false) {
      const s = media.screenVideoTrack?.getSettings();
      if (s) qualityBadge.textContent = `${s.height}p · ${Math.round(s.frameRate || 0)}fps`;
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Dispositivos (microfone / saída / qualidade / fps)
// ---------------------------------------------------------------------------
async function populateDevicePickers() {
  const { mics, speakers } = await media.listDevices();
  selectMic.innerHTML = mics
    .map((d, i) => `<option value="${d.deviceId}">${d.label || `Microfone ${i + 1}`}</option>`)
    .join('');
  if (media.selectedMicId) selectMic.value = media.selectedMicId;

  if (media.supportsOutputSelection() && speakers.length) {
    selectSpeaker.innerHTML = speakers
      .map((d, i) => `<option value="${d.deviceId}">${d.label || `Saída ${i + 1}`}</option>`)
      .join('');
  } else {
    selectSpeaker.innerHTML = '<option value="">Padrão do sistema</option>';
    selectSpeaker.disabled = true;
  }
}

selectMic.addEventListener('change', async () => {
  const track = await media.switchMic(selectMic.value);
  webrtc.setLocalMicTrack(track);
  vad.start(track);
});

selectSpeaker.addEventListener('change', () => media.setSpeakerDevice(selectSpeaker.value));

btnDevices.addEventListener('click', () => {
  devicesPanel.hidden = !devicesPanel.hidden;
});
document.addEventListener('click', (e) => {
  if (!devicesPanel.hidden && !devicesPanel.contains(e.target) && e.target !== btnDevices && !btnDevices.contains(e.target)) {
    devicesPanel.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Painel de participantes (mobile)
// ---------------------------------------------------------------------------
function openParticipants() {
  participantsPanel.dataset.open = 'true';
  participantsScrim.dataset.open = 'true';
}
function closeParticipants() {
  participantsPanel.dataset.open = 'false';
  participantsScrim.dataset.open = 'false';
}
btnToggleParticipants.addEventListener('click', openParticipants);
btnCloseParticipants.addEventListener('click', closeParticipants);
participantsScrim.addEventListener('click', closeParticipants);

// ---------------------------------------------------------------------------
// Diversos: copiar link, tela cheia, sair
// ---------------------------------------------------------------------------
btnCopyLink.addEventListener('click', async () => {
  const url = `${window.location.origin}/room/${roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    UI.showToast(toastContainer, 'Link copiado!', 'success');
  } catch {
    UI.showToast(toastContainer, url);
  }
});

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    screenShareView.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
});

btnLeave.addEventListener('click', () => {
  cleanupAndReturnToLobby();
});
window.addEventListener('beforeunload', () => {
  signaling?.leaveRoom();
});

function cleanupAndReturnToLobby() {
  signaling?.leaveRoom();
  signaling?.disconnect();
  signaling = null;
  webrtc?.removeAllPeers();
  webrtc = null;
  if (adaptiveQualityIntervalId) clearInterval(adaptiveQualityIntervalId);
  media.cleanup();
  vad.stop();
  participants.clear();
  shareVideoTracks.clear();
  activeShareId = null;

  window.history.pushState({}, '', '/');
  viewRoom.hidden = true;
  viewLanding.hidden = false;
  screenShareView.hidden = true;
  stageEmpty.hidden = false;
  participantsList.innerHTML = '';
  speakerGrid.innerHTML = '';
  btnMic.dataset.active = 'false';
  btnScreenShare.dataset.active = 'false';
}

// Auto-entrar se a URL já apontar pra uma sala e o nome já tiver sido usado antes nesta aba
if (prefillRoomId) {
  inputRoomCode.value = prefillRoomId;
  inputName.focus();
}
