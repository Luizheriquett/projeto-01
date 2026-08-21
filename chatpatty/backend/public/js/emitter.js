// Event emitter minúsculo — evita dependência de biblioteca externa pesada.
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Emitter] erro no listener de "${event}"`, err);
      }
    });
  }
}
