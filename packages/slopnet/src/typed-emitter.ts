type Listener<T> = (data: T) => void;

export class TypedEmitter<Events extends Record<string, any>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const wrappedListener: Listener<Events[K]> = (data) => {
      this.off(event, wrappedListener);
      listener(data);
    };
    return this.on(event, wrappedListener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
