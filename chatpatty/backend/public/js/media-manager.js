import { Emitter } from './emitter.js';

const QUALITY_PRESETS = {
  1440: { width: 2560, height: 1440 },
  1080: { width: 1920, height: 1080 },
  720: { width: 1280, height: 720 },
};

// Bitrates alvo por faixa de qualidade (kbps) — usados na adaptação automática
const BITRATE_LADDER = [
  { minWidth: 2560, kbps: 8000 },
  { minWidth: 1920, kbps: 5000 },
  { minWidth: 1280, kbps: 2500 },
  { minWidth: 0, kbps: 1000 },
];

export class MediaManager extends Emitter {
  constructor() {
    super();
    this.micStream = null;
    this.micTrack = null;
    this.screenStream = null;
    this.screenVideoTrack = null;
    this.screenAudioTrack = null;

    this.selectedMicId = null;
    this.selectedSpeakerId = null;
    this.qualityPreference = 'auto'; // 'auto' | '1440' | '1080' | '720'
    this.fpsPreference = 30;

    // pipeline de áudio remoto: peerId -> { ctx, source, gain, destination, audioEl }
    this._remoteAudioPipelines = new Map();
  }

  // ------------------------------------------------------------ microfone --

  async initMic(deviceId) {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: deviceId ? { exact: deviceId } : undefined,
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.micStream = stream;
    this.micTrack = stream.getAudioTracks()[0];
    this.micTrack.enabled = false; // inicia mutado — o usuário liga explicitamente
    this.selectedMicId = this.micTrack.getSettings().deviceId || deviceId || null;
    return this.micTrack;
  }

  async switchMic(deviceId) {
    const wasEnabled = this.micTrack ? this.micTrack.enabled : false;
    const oldTrack = this.micTrack;
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: deviceId },
      },
    });
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = wasEnabled;
    this.micStream = newStream;
    this.micTrack = newTrack;
    this.selectedMicId = deviceId;
    oldTrack?.stop();
    this.emit('mic-track-changed', newTrack);
    return newTrack;
  }

  setMicEnabled(enabled) {
    if (this.micTrack) this.micTrack.enabled = enabled;
  }

  isMicEnabled() {
    return !!this.micTrack?.enabled;
  }

  // ---------------------------------------------------- compartilhar tela --

  _resolveConstraints() {
    const q = this.qualityPreference === 'auto' ? '1080' : this.qualityPreference;
    const preset = QUALITY_PRESETS[q] || QUALITY_PRESETS['1080'];
    return {
      video: {
        width: { ideal: preset.width, max: 2560 },
        height: { ideal: preset.height, max: 1440 },
        frameRate: { ideal: this.fpsPreference, max: 60 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
  }

  async startScreenShare() {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Este navegador não suporta compartilhamento de tela.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(this._resolveConstraints());
    this.screenStream = stream;
    this.screenVideoTrack = stream.getVideoTracks()[0];
    this.screenAudioTrack = stream.getAudioTracks()[0] || null;

    // Se o usuário parar a transmissão pelo controle nativo do navegador
    // (barra "Parar compartilhamento"), precisamos refletir isso na UI.
    this.screenVideoTrack.addEventListener('ended', () => {
      this.emit('screen-share-ended-natively');
    });

    const tracks = [this.screenVideoTrack];
    if (this.screenAudioTrack) tracks.push(this.screenAudioTrack);
    return tracks;
  }

  stopScreenShare() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
    }
    this.screenStream = null;
    this.screenVideoTrack = null;
    this.screenAudioTrack = null;
  }

  isSharingScreen() {
    return !!this.screenVideoTrack;
  }

  /** Retorna o kbps recomendado para a largura atual (usado na adaptação automática). */
  bitrateForWidth(width) {
    const tier = BITRATE_LADDER.find((t) => width >= t.minWidth);
    return tier ? tier.kbps : 1000;
  }

  // ------------------------------------------------------------ dispositivos --

  async listDevices() {
    // enumerateDevices só retorna labels após permissão concedida
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((d) => d.kind === 'audioinput'),
      speakers: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }

  supportsOutputSelection() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  async setSpeakerDevice(deviceId) {
    this.selectedSpeakerId = deviceId;
    if (!this.supportsOutputSelection()) return;
    for (const pipeline of this._remoteAudioPipelines.values()) {
      try {
        await pipeline.audioEl.setSinkId(deviceId);
      } catch (err) {
        console.warn('[Media] setSinkId falhou', err);
      }
    }
  }

  // ------------------------------------------------------ áudio remoto ----

  /**
   * Cria um pipeline de Web Audio para uma faixa remota: permite controlar
   * o volume individualmente (GainNode) e escolher o dispositivo de saída
   * (via <audio> oculto alimentado por um MediaStreamAudioDestinationNode).
   */
  attachRemoteAudioTrack(peerId, track) {
    this.detachRemoteAudio(peerId);

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const destination = ctx.createMediaStreamDestination();
    source.connect(gain).connect(destination);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = destination.stream;
    audioEl.dataset.peerId = peerId;
    document.body.appendChild(audioEl);

    if (this.selectedSpeakerId && this.supportsOutputSelection()) {
      audioEl.setSinkId(this.selectedSpeakerId).catch(() => {});
    }

    this._remoteAudioPipelines.set(peerId, { ctx, source, gain, destination, audioEl, track });
  }

  setRemoteVolume(peerId, volume /* 0..2 */) {
    const pipeline = this._remoteAudioPipelines.get(peerId);
    if (pipeline) pipeline.gain.gain.value = volume;
  }

  detachRemoteAudio(peerId) {
    const pipeline = this._remoteAudioPipelines.get(peerId);
    if (!pipeline) return;
    pipeline.audioEl.pause();
    pipeline.audioEl.srcObject = null;
    pipeline.audioEl.remove();
    pipeline.ctx.close().catch(() => {});
    this._remoteAudioPipelines.delete(peerId);
  }

  detachAllRemoteAudio() {
    Array.from(this._remoteAudioPipelines.keys()).forEach((id) => this.detachRemoteAudio(id));
  }

  cleanup() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.stopScreenShare();
    this.detachAllRemoteAudio();
  }
}
