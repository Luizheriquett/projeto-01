import { Emitter } from './emitter.js';

/**
 * WebRTCManager
 * ------------------------------------------------------------------------
 * Implementa uma malha (mesh) peer-to-peer real: uma RTCPeerConnection
 * dedicada para cada par de participantes na sala. O padrão de
 * "negociação perfeita" (perfect negotiation, recomendado pelo W3C/MDN)
 * é usado para evitar condições de corrida quando os dois lados tentam
 * renegociar ao mesmo tempo (ex: ambos ligam a tela juntos).
 *
 * Eventos emitidos:
 *  - 'remote-track'   { peerId, track, streams }
 *  - 'peer-connection-state' { peerId, state }
 *  - 'stats' { peerId, ...métricas }
 */
export class WebRTCManager extends Emitter {
  constructor(signaling, selfId, iceServers) {
    super();
    this.signaling = signaling;
    this.selfId = selfId;
    this.iceServers = iceServers && iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
    this.peers = new Map(); // peerId -> { pc, makingOffer, ignoreOffer, polite, senders: Map<trackId, RTCRtpSender> }
    this.localMicTrack = null;
    this.localScreenTracks = []; // [videoTrack, audioTrack?]
    this._statsIntervals = new Map();

    signaling.on('signal', ({ from, data }) => this._handleSignal(from, data));
  }

  // -------------------------------------------------------------- setup --

  addPeer(peerId) {
    if (this.peers.has(peerId) || peerId === this.selfId) return;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
    });

    const peer = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      polite: this.selfId > peerId, // desempate determinístico e consistente nos dois lados
      senders: new Map(),
    };
    this.peers.set(peerId, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signaling.sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error('[WebRTC] erro em onnegotiationneeded', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.sendSignal(peerId, { candidate });
    };

    pc.ontrack = (event) => {
      this.emit('remote-track', { peerId, track: event.track, streams: event.streams });
    };

    pc.onconnectionstatechange = () => {
      this.emit('peer-connection-state', { peerId, state: pc.connectionState });
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        this._tryIceRestart(peerId);
      }
    };

    // Adiciona a mídia local já disponível a este novo par
    if (this.localMicTrack) {
      const sender = pc.addTrack(this.localMicTrack);
      peer.senders.set(this.localMicTrack.id, sender);
    }
    for (const track of this.localScreenTracks) {
      const sender = pc.addTrack(track);
      peer.senders.set(track.id, sender);
    }

    this._startStatsLoop(peerId);
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.getSenders().forEach((s) => {
      try { peer.pc.removeTrack(s); } catch {}
    });
    peer.pc.close();
    this.peers.delete(peerId);
    clearInterval(this._statsIntervals.get(peerId));
    this._statsIntervals.delete(peerId);
  }

  removeAllPeers() {
    Array.from(this.peers.keys()).forEach((id) => this.removePeer(id));
  }

  async _tryIceRestart(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
      this.signaling.sendSignal(peerId, { description: peer.pc.localDescription });
    } catch (err) {
      console.warn('[WebRTC] falha ao tentar ICE restart', err);
    } finally {
      peer.makingOffer = false;
    }
  }

  // ------------------------------------------------------- sinalização --

  async _handleSignal(peerId, data) {
    let peer = this.peers.get(peerId);
    if (!peer) peer = this.addPeer(peerId);
    const { pc } = peer;

    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        if (offerCollision) {
          // lado educado: recua e aceita a oferta do outro lado
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(data.description),
          ]);
        } else {
          await pc.setRemoteDescription(data.description);
        }

        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.signaling.sendSignal(peerId, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) console.warn('[WebRTC] ICE candidate rejeitado', err);
        }
      }
    } catch (err) {
      console.error('[WebRTC] erro ao processar sinal', err);
    }
  }

  // -------------------------------------------------------- mídia local --

  setLocalMicTrack(track) {
    this.localMicTrack = track;
    for (const peer of this.peers.values()) {
      const existingSender = [...peer.senders.values()].find((s) => s.track?.kind === 'audio' && s.track?.label !== 'screen-audio');
      if (existingSender) {
        existingSender.replaceTrack(track);
      } else {
        const sender = peer.pc.addTrack(track);
        peer.senders.set(track.id, sender);
      }
    }
  }

  addLocalScreenTracks(tracks) {
    this.localScreenTracks = tracks;
    for (const peer of this.peers.values()) {
      for (const track of tracks) {
        const sender = peer.pc.addTrack(track);
        peer.senders.set(track.id, sender);
      }
    }
  }

  removeLocalScreenTracks() {
    for (const peer of this.peers.values()) {
      for (const track of this.localScreenTracks) {
        const sender = peer.senders.get(track.id);
        if (sender) {
          try { peer.pc.removeTrack(sender); } catch {}
          peer.senders.delete(track.id);
        }
      }
    }
    this.localScreenTracks = [];
  }

  /** Ajusta o bitrate máximo do vídeo de tela para todos os pares (adaptação de qualidade). */
  async setScreenMaxBitrate(kbps) {
    for (const peer of this.peers.values()) {
      const sender = [...peer.senders.values()].find((s) => s.track?.kind === 'video');
      if (!sender) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      try {
        await sender.setParameters(params);
      } catch (err) {
        // alguns navegadores exigem que getParameters tenha sido chamado após 1ª negociação
      }
    }
  }

  /** Reduz a resolução transmitida proporcionalmente (usado na adaptação automática). */
  async setScreenDownscale(factor) {
    for (const peer of this.peers.values()) {
      const sender = [...peer.senders.values()].find((s) => s.track?.kind === 'video');
      if (!sender) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].scaleResolutionDownBy = Math.max(1, factor);
      try {
        await sender.setParameters(params);
      } catch {}
    }
  }

  // ----------------------------------------------------------- métricas --

  _startStatsLoop(peerId) {
    const interval = setInterval(async () => {
      const peer = this.peers.get(peerId);
      if (!peer) return clearInterval(interval);
      try {
        const stats = await peer.pc.getStats();
        let packetsLost = 0;
        let packetsReceived = 0;
        let rtt = null;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && !report.isRemote) {
            packetsLost += report.packetsLost || 0;
            packetsReceived += report.packetsReceived || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
            rtt = report.currentRoundTripTime;
          }
        });
        const lossRatio = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
        this.emit('stats', { peerId, lossRatio, rtt });
      } catch {}
    }, 3000);
    this._statsIntervals.set(peerId, interval);
  }
}
