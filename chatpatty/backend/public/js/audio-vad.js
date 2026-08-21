import { Emitter } from './emitter.js';

/**
 * Detector simples de atividade de voz baseado em energia do sinal (RMS)
 * com debounce, para não piscar o indicador de "falando" a cada respiração.
 * Roda inteiramente no cliente, sobre a própria faixa de microfone local.
 */
export class VoiceActivityDetector extends Emitter {
  constructor({ threshold = 0.02, holdMs = 350 } = {}) {
    super();
    this.threshold = threshold;
    this.holdMs = holdMs;
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.rafId = null;
    this.speaking = false;
    this.lastAboveThreshold = 0;
    this._data = null;
  }

  start(track) {
    this.stop();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this._data = new Float32Array(this.analyser.fftSize);
    this._loop();
  }

  _loop = () => {
    this.rafId = requestAnimationFrame(this._loop);
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this._data);

    let sumSquares = 0;
    for (let i = 0; i < this._data.length; i++) sumSquares += this._data[i] * this._data[i];
    const rms = Math.sqrt(sumSquares / this._data.length);

    const now = performance.now();
    if (rms > this.threshold) {
      this.lastAboveThreshold = now;
      if (!this.speaking) {
        this.speaking = true;
        this.emit('change', true);
      }
    } else if (this.speaking && now - this.lastAboveThreshold > this.holdMs) {
      this.speaking = false;
      this.emit('change', false);
    }
  };

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking = false;
  }
}
