import { Emitter } from './emitter.js';

/**
 * Encapsula a conexão Socket.IO usada exclusivamente para SINALIZAÇÃO
 * (quem entrou, quem saiu, troca de SDP/ICE). Nenhuma mídia trafega aqui.
 */
export class SignalingClient extends Emitter {
  constructor() {
    super();
    this.socket = null;
    this.selfId = null;
  }

  /**
   * Cria a conexão e resolve assim que o handshake inicial terminar.
   * Importante: os listeners de encaminhamento (_bindForwarders) são
   * registrados apenas UMA VEZ por instância, para nunca duplicar em
   * caso de reconexão automática — duplicar listeners é o que causava
   * eventos (e toasts) repetidos.
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = io({
        transports: ['websocket', 'polling'],
        reconnectionAttempts: Infinity,
        reconnectionDelay: 800,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      const onConnect = () => {
        this._bindForwarders();
        this.socket.off('connect_error', onError);
        resolve();
      };
      const onError = (err) => {
        this.socket.off('connect', onConnect);
        reject(err);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('connect_error', onError);
    });
  }

  _bindForwarders() {
    if (this._forwardersBound) return;
    this._forwardersBound = true;

    this.socket.on('connect', () => this.emit('connect'));
    this.socket.on('disconnect', (reason) => this.emit('disconnect', reason));
    this.socket.on('connect_error', (err) => this.emit('connect_error', err));
    this.socket.on('reconnect_attempt', () => this.emit('reconnecting'));
    this.socket.on('reconnect', () => this.emit('reconnected'));

    this.socket.on('user-joined', (u) => this.emit('user-joined', u));
    this.socket.on('user-left', (u) => this.emit('user-left', u));
    this.socket.on('user-mic-state', (u) => this.emit('user-mic-state', u));
    this.socket.on('user-speaking-state', (u) => this.emit('user-speaking-state', u));
    this.socket.on('user-screen-share-state', (u) => this.emit('user-screen-share-state', u));
    this.socket.on('signal', (payload) => this.emit('signal', payload));
  }

  joinRoom({ roomId, name, avatar }) {
    return new Promise((resolve, reject) => {
      this.socket.emit('join-room', { roomId, name, avatar }, (res) => {
        if (!res) {
          return reject(new Error('Servidor não respondeu ao tentar entrar na sala'));
        }
        if (!res?.ok) {
          return reject(new Error(res?.error || 'Falha ao entrar na sala'));
        }
        this.selfId = res.selfId;
        resolve(res);
      });
    });
  }

  sendSignal(to, data) {
    this.socket.emit('signal', { to, data });
  }

  setMicState(muted) {
    this.socket.emit('mic-state', { muted });
  }

  setSpeaking(speaking) {
    this.socket.emit('speaking-state', { speaking });
  }

  setScreenShareState(sharing) {
    this.socket.emit('screen-share-state', { sharing });
  }

  leaveRoom() {
    this.socket?.emit('leave-room');
  }

  disconnect() {
    this.socket?.disconnect();
  }
}
