import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../../typed-emitter.js';

interface TestEvents {
  message: { text: string };
  count: { value: number };
  empty: undefined;
}

describe('TypedEmitter', () => {
  let emitter: TypedEmitter<TestEvents>;

  beforeEach(() => {
    emitter = new TypedEmitter<TestEvents>();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('should emit and receive events', () => {
    const listener = vi.fn();
    emitter.on('message', listener);

    (emitter as any).emit('message', { text: 'hello' });

    expect(listener).toHaveBeenCalledWith({ text: 'hello' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should support multiple listeners for the same event', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.on('message', listener1);
    emitter.on('message', listener2);

    (emitter as any).emit('message', { text: 'test' });

    expect(listener1).toHaveBeenCalledWith({ text: 'test' });
    expect(listener2).toHaveBeenCalledWith({ text: 'test' });
  });

  it('should support multiple event types', () => {
    const messageListener = vi.fn();
    const countListener = vi.fn();
    emitter.on('message', messageListener);
    emitter.on('count', countListener);

    (emitter as any).emit('message', { text: 'hi' });
    (emitter as any).emit('count', { value: 42 });

    expect(messageListener).toHaveBeenCalledWith({ text: 'hi' });
    expect(countListener).toHaveBeenCalledWith({ value: 42 });
    expect(messageListener).toHaveBeenCalledTimes(1);
    expect(countListener).toHaveBeenCalledTimes(1);
  });

  it('should remove listener with off()', () => {
    const listener = vi.fn();
    emitter.on('message', listener);

    (emitter as any).emit('message', { text: 'first' });
    emitter.off('message', listener);
    (emitter as any).emit('message', { text: 'second' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should return an unsubscribe function from on()', () => {
    const listener = vi.fn();
    const unsub = emitter.on('message', listener);

    (emitter as any).emit('message', { text: 'first' });
    unsub();
    (emitter as any).emit('message', { text: 'second' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should support once() that fires only one time', () => {
    const listener = vi.fn();
    emitter.once('message', listener);

    (emitter as any).emit('message', { text: 'first' });
    (emitter as any).emit('message', { text: 'second' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ text: 'first' });
  });

  it('should return an unsubscribe function from once()', () => {
    const listener = vi.fn();
    const unsub = emitter.once('message', listener);

    unsub();
    (emitter as any).emit('message', { text: 'never' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('should handle events with undefined data', () => {
    const listener = vi.fn();
    emitter.on('empty', listener);

    (emitter as any).emit('empty');

    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it('should removeAllListeners()', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.on('message', listener1);
    emitter.on('count', listener2);

    emitter.removeAllListeners();

    (emitter as any).emit('message', { text: 'test' });
    (emitter as any).emit('count', { value: 1 });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).not.toHaveBeenCalled();
  });

  it('should not throw when emitting events with no listeners', () => {
    expect(() => {
      (emitter as any).emit('message', { text: 'nobody listening' });
    }).not.toThrow();
  });

  it('should handle listener that removes itself during emission', () => {
    const listener1 = vi.fn(() => {
      emitter.off('message', listener1);
    });
    const listener2 = vi.fn();

    emitter.on('message', listener1);
    emitter.on('message', listener2);

    (emitter as any).emit('message', { text: 'test' });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});
