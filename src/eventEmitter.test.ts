import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Event Emitter', () => {
  type EventMap = {
    click: { x: number; y: number };
    change: string;
    empty: void;
  };

  class EventEmitter<T extends Record<string, unknown>> {
    private listeners: Map<keyof T, Set<(data: unknown) => void>> = new Map();

    on<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(callback as (data: unknown) => void);
    }

    off<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
      this.listeners.get(event)?.delete(callback as (data: unknown) => void);
    }

    emit<K extends keyof T>(event: K, data: T[K]): void {
      this.listeners.get(event)?.forEach((cb) => cb(data));
    }

    once<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
      const wrapper = (data: T[K]) => {
        callback(data);
        this.off(event, wrapper);
      };
      this.on(event, wrapper);
    }

    removeAllListeners<K extends keyof T>(event?: K): void {
      if (event) {
        this.listeners.delete(event);
      } else {
        this.listeners.clear();
      }
    }

    listenerCount<K extends keyof T>(event: K): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  it('registers and triggers event listeners', () => {
    const emitter = new EventEmitter<EventMap>();
    const callback = vi.fn();

    emitter.on('change', callback);
    emitter.emit('change', 'test');

    expect(callback).toHaveBeenCalledWith('test');
  });

  it('supports multiple listeners for same event', () => {
    const emitter = new EventEmitter<EventMap>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    emitter.on('change', cb1);
    emitter.on('change', cb2);
    emitter.emit('change', 'value');

    expect(cb1).toHaveBeenCalledWith('value');
    expect(cb2).toHaveBeenCalledWith('value');
  });

  it('removes specific listener', () => {
    const emitter = new EventEmitter<EventMap>();
    const callback = vi.fn();

    emitter.on('change', callback);
    emitter.off('change', callback);
    emitter.emit('change', 'test');

    expect(callback).not.toHaveBeenCalled();
  });

  it('once listener fires only once', () => {
    const emitter = new EventEmitter<EventMap>();
    const callback = vi.fn();

    emitter.once('change', callback);
    emitter.emit('change', 'first');
    emitter.emit('change', 'second');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('first');
  });

  it('removes all listeners for specific event', () => {
    const emitter = new EventEmitter<EventMap>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    emitter.on('change', cb1);
    emitter.on('change', cb2);
    emitter.removeAllListeners('change');
    emitter.emit('change', 'test');

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('removes all listeners for all events', () => {
    const emitter = new EventEmitter<EventMap>();
    const changeCb = vi.fn();
    const clickCb = vi.fn();

    emitter.on('change', changeCb);
    emitter.on('click', clickCb);
    emitter.removeAllListeners();
    emitter.emit('change', 'test');
    emitter.emit('click', { x: 0, y: 0 });

    expect(changeCb).not.toHaveBeenCalled();
    expect(clickCb).not.toHaveBeenCalled();
  });

  it('counts listeners correctly', () => {
    const emitter = new EventEmitter<EventMap>();

    expect(emitter.listenerCount('change')).toBe(0);

    emitter.on('change', () => {});
    emitter.on('change', () => {});

    expect(emitter.listenerCount('change')).toBe(2);
  });

  it('handles events with object data', () => {
    const emitter = new EventEmitter<EventMap>();
    const callback = vi.fn();

    emitter.on('click', callback);
    emitter.emit('click', { x: 100, y: 200 });

    expect(callback).toHaveBeenCalledWith({ x: 100, y: 200 });
  });
});

describe('Observable state', () => {
  class Observable<T> {
    private value: T;
    private subscribers: Set<(value: T) => void> = new Set();

    constructor(initial: T) {
      this.value = initial;
    }

    get(): T {
      return this.value;
    }

    set(newValue: T): void {
      if (newValue !== this.value) {
        this.value = newValue;
        this.notify();
      }
    }

    subscribe(callback: (value: T) => void): () => void {
      this.subscribers.add(callback);
      return () => this.subscribers.delete(callback);
    }

    private notify(): void {
      this.subscribers.forEach((cb) => cb(this.value));
    }
  }

  it('stores and retrieves value', () => {
    const state = new Observable(10);
    expect(state.get()).toBe(10);
  });

  it('updates value and notifies subscribers', () => {
    const state = new Observable(10);
    const callback = vi.fn();

    state.subscribe(callback);
    state.set(20);

    expect(state.get()).toBe(20);
    expect(callback).toHaveBeenCalledWith(20);
  });

  it('does not notify when value unchanged', () => {
    const state = new Observable(10);
    const callback = vi.fn();

    state.subscribe(callback);
    state.set(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function', () => {
    const state = new Observable(10);
    const callback = vi.fn();

    const unsubscribe = state.subscribe(callback);
    unsubscribe();
    state.set(20);

    expect(callback).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers', () => {
    const state = new Observable('initial');
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    state.subscribe(cb1);
    state.subscribe(cb2);
    state.set('updated');

    expect(cb1).toHaveBeenCalledWith('updated');
    expect(cb2).toHaveBeenCalledWith('updated');
  });
});

describe('Promise utilities', () => {
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('delay resolves after specified time', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    delay(100).then(callback);

    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(callback).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('timeout pattern with AbortController', async () => {
    function fetchWithTimeout<T>(
      fn: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number
    ): Promise<T> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      return fn(controller.signal).finally(() => clearTimeout(timeoutId));
    }

    const fastFn = vi.fn(async () => 'result');
    const result = await fetchWithTimeout(fastFn, 1000);

    expect(result).toBe('result');
    expect(fastFn).toHaveBeenCalledTimes(1);
  });

  it('creates a cancellable promise', async () => {
    function createCancellable<T>(
      executor: (
        resolve: (value: T) => void,
        reject: (reason: unknown) => void,
        signal: AbortSignal
      ) => void
    ): { promise: Promise<T>; cancel: () => void } {
      const controller = new AbortController();

      const promise = new Promise<T>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('Cancelled'));
        });
        executor(resolve, reject, controller.signal);
      });

      return {
        promise,
        cancel: () => controller.abort(),
      };
    }

    const { promise, cancel } = createCancellable<string>((resolve) => {
      setTimeout(() => resolve('done'), 100);
    });

    cancel();

    await expect(promise).rejects.toThrow('Cancelled');
  });

  it('wraps callback in promise', async () => {
    function promisify<T>(
      fn: (callback: (err: Error | null, result?: T) => void) => void
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        fn((err, result) => {
          if (err) reject(err);
          else resolve(result as T);
        });
      });
    }

    const asyncOp = (cb: (err: Error | null, result?: number) => void) => {
      cb(null, 42);
    };

    const result = await promisify<number>(asyncOp);
    expect(result).toBe(42);
  });
});

describe('Pub/Sub pattern', () => {
  class PubSub {
    private channels: Map<string, Set<(message: unknown) => void>> = new Map();

    subscribe(channel: string, callback: (message: unknown) => void): () => void {
      if (!this.channels.has(channel)) {
        this.channels.set(channel, new Set());
      }
      this.channels.get(channel)!.add(callback);

      return () => this.channels.get(channel)?.delete(callback);
    }

    publish(channel: string, message: unknown): void {
      this.channels.get(channel)?.forEach((cb) => cb(message));
    }

    getChannels(): string[] {
      return Array.from(this.channels.keys());
    }

    getSubscriberCount(channel: string): number {
      return this.channels.get(channel)?.size ?? 0;
    }
  }

  it('publishes messages to subscribers', () => {
    const pubsub = new PubSub();
    const callback = vi.fn();

    pubsub.subscribe('news', callback);
    pubsub.publish('news', { headline: 'Test' });

    expect(callback).toHaveBeenCalledWith({ headline: 'Test' });
  });

  it('supports multiple channels', () => {
    const pubsub = new PubSub();
    const newsCb = vi.fn();
    const sportsCb = vi.fn();

    pubsub.subscribe('news', newsCb);
    pubsub.subscribe('sports', sportsCb);

    pubsub.publish('news', 'news message');

    expect(newsCb).toHaveBeenCalledWith('news message');
    expect(sportsCb).not.toHaveBeenCalled();
  });

  it('unsubscribes from channel', () => {
    const pubsub = new PubSub();
    const callback = vi.fn();

    const unsubscribe = pubsub.subscribe('events', callback);
    unsubscribe();
    pubsub.publish('events', 'test');

    expect(callback).not.toHaveBeenCalled();
  });

  it('lists active channels', () => {
    const pubsub = new PubSub();

    pubsub.subscribe('alpha', () => {});
    pubsub.subscribe('beta', () => {});

    expect(pubsub.getChannels()).toContain('alpha');
    expect(pubsub.getChannels()).toContain('beta');
  });

  it('counts subscribers per channel', () => {
    const pubsub = new PubSub();

    pubsub.subscribe('test', () => {});
    pubsub.subscribe('test', () => {});
    pubsub.subscribe('other', () => {});

    expect(pubsub.getSubscriberCount('test')).toBe(2);
    expect(pubsub.getSubscriberCount('other')).toBe(1);
    expect(pubsub.getSubscriberCount('nonexistent')).toBe(0);
  });
});

describe('State machine', () => {
  type State = 'idle' | 'loading' | 'success' | 'error';
  type Event = 'FETCH' | 'RESOLVE' | 'REJECT' | 'RESET';

  class StateMachine {
    private state: State = 'idle';
    private transitions: Record<State, Partial<Record<Event, State>>> = {
      idle: { FETCH: 'loading' },
      loading: { RESOLVE: 'success', REJECT: 'error' },
      success: { RESET: 'idle', FETCH: 'loading' },
      error: { RESET: 'idle', FETCH: 'loading' },
    };

    getState(): State {
      return this.state;
    }

    send(event: Event): boolean {
      const nextState = this.transitions[this.state][event];
      if (nextState) {
        this.state = nextState;
        return true;
      }
      return false;
    }

    canTransition(event: Event): boolean {
      return !!this.transitions[this.state][event];
    }
  }

  it('starts in initial state', () => {
    const machine = new StateMachine();
    expect(machine.getState()).toBe('idle');
  });

  it('transitions on valid events', () => {
    const machine = new StateMachine();

    machine.send('FETCH');
    expect(machine.getState()).toBe('loading');

    machine.send('RESOLVE');
    expect(machine.getState()).toBe('success');
  });

  it('ignores invalid transitions', () => {
    const machine = new StateMachine();

    const result = machine.send('RESOLVE');
    expect(result).toBe(false);
    expect(machine.getState()).toBe('idle');
  });

  it('resets to idle state', () => {
    const machine = new StateMachine();

    machine.send('FETCH');
    machine.send('RESOLVE');
    machine.send('RESET');

    expect(machine.getState()).toBe('idle');
  });

  it('handles error state', () => {
    const machine = new StateMachine();

    machine.send('FETCH');
    machine.send('REJECT');

    expect(machine.getState()).toBe('error');
  });

  it('checks if transition is possible', () => {
    const machine = new StateMachine();

    expect(machine.canTransition('FETCH')).toBe(true);
    expect(machine.canTransition('RESOLVE')).toBe(false);
  });

  it('allows retry from error state', () => {
    const machine = new StateMachine();

    machine.send('FETCH');
    machine.send('REJECT');
    machine.send('FETCH');

    expect(machine.getState()).toBe('loading');
  });
});
