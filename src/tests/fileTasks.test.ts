import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

class MockWorker {
  private listeners = new Map<string, Listener[]>();
  readonly messages: unknown[] = [];
  postMessage = vi.fn((message: unknown) => {
    this.messages.push(message);
  });
  terminate = vi.fn(async () => 0);
  removeAllListeners = vi.fn(() => {
    this.listeners.clear();
    return this;
  });

  on(event: string, listener: Listener): this {
    const current = this.listeners.get(event) || [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const current = this.listeners.get(event) || [];
    for (const listener of current) {
      listener(...args);
    }
  }
}

const workerInstances: MockWorker[] = [];
const managers: Array<{ shutdown: () => Promise<void> }> = [];

vi.mock('worker_threads', () => ({
  Worker: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { Worker } from 'worker_threads';
import { FileTaskManager } from '../fileTasks';
import { logger } from '../utils/logger';

const WorkerMock = Worker as unknown as {
  mockReset: () => void;
  mockImplementation: (impl: new (...args: unknown[]) => unknown) => void;
};

function createManager(workerCount = 1): FileTaskManager {
  const manager = new FileTaskManager(workerCount);
  managers.push(manager);
  return manager;
}

function getTaskId(worker: MockWorker): string {
  const first = worker.messages.find((msg) => {
    return typeof msg === 'object' && msg !== null && 'id' in (msg as Record<string, unknown>);
  }) as { id: string } | undefined;
  if (!first) {
    throw new Error('No task message found on worker');
  }
  return first.id;
}

beforeEach(() => {
  workerInstances.length = 0;
  managers.length = 0;
  WorkerMock.mockReset();
  vi.mocked(logger.error).mockReset();
  WorkerMock.mockImplementation(function MockedWorker(): import('worker_threads').Worker {
    const worker = new MockWorker();
    workerInstances.push(worker);
    return worker as unknown as import('worker_threads').Worker;
  } as unknown as new (...args: unknown[]) => unknown);
});

afterEach(async () => {
  await Promise.all(
    managers.map(async (manager) => {
      try {
        await manager.shutdown();
      } catch {}
    })
  );
});

describe('FileTaskManager', () => {
  it('dispatches tasks and resolves results', async () => {
    const manager = createManager(1);
    const promise = manager.runTask<string[]>('search-files', { query: 'x' }, 'op-1');
    const worker = workerInstances[0];
    const taskId = getTaskId(worker);

    worker.emit('message', {
      type: 'result',
      id: taskId,
      success: true,
      data: ['match-1'],
    });

    await expect(promise).resolves.toEqual(['match-1']);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'search-files',
        operationId: 'op-1',
      })
    );
  });

  it('emits progress updates from workers', async () => {
    const manager = createManager(1);
    const onProgress = vi.fn();
    manager.on('progress', onProgress);

    const promise = manager.runTask('search-files', { query: 'x' }, 'op-progress');
    const worker = workerInstances[0];
    const taskId = getTaskId(worker);

    worker.emit('message', {
      type: 'progress',
      task: 'search-files',
      operationId: 'op-progress',
      data: { current: 1, total: 10 },
    });
    worker.emit('message', {
      type: 'result',
      id: taskId,
      success: true,
      data: [],
    });

    await expect(promise).resolves.toEqual([]);
    expect(onProgress).toHaveBeenCalledWith({
      type: 'progress',
      task: 'search-files',
      operationId: 'op-progress',
      data: { current: 1, total: 10 },
    });
  });

  it('cancels queued operations and keeps active ones running', async () => {
    const manager = createManager(1);
    const active = manager.runTask('search-files', { query: 'active' }, 'op-active');
    const worker = workerInstances[0];
    const activeId = getTaskId(worker);

    const queued = manager.runTask('search-files', { query: 'queued' }, 'op-queued');
    manager.cancelOperation('op-queued');

    await expect(queued).rejects.toThrow('Calculation cancelled');
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel', operationId: 'op-queued' });

    worker.emit('message', {
      type: 'result',
      id: activeId,
      success: true,
      data: ['ok'],
    });
    await expect(active).resolves.toEqual(['ok']);
  });

  it('rejects pending tasks during shutdown', async () => {
    const manager = createManager(1);
    const pending = manager.runTask('search-files', { query: 'x' }, 'op-shutdown');

    await manager.shutdown();

    await expect(pending).rejects.toThrow('File task manager shutting down');
    expect(workerInstances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects when queue is full', async () => {
    const manager = createManager(1);
    (manager as unknown as { queue: unknown[] }).queue = new Array(1000).fill({});
    (manager as unknown as { pending: Map<string, unknown> }).pending = new Map();

    await expect(manager.runTask('search-files', { query: 'x' })).rejects.toThrow(
      'Task queue is full'
    );
  });

  it('replaces failed workers and continues processing', async () => {
    const manager = createManager(1);
    const firstTask = manager.runTask('search-files', { query: 'first' }, 'op-1');
    const firstWorker = workerInstances[0];

    firstWorker.emit('error', new Error('worker boom'));
    await expect(firstTask).rejects.toThrow('worker boom');
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
    expect(workerInstances.length).toBe(2);

    const secondTask = manager.runTask('search-files', { query: 'second' }, 'op-2');
    const secondWorker = workerInstances[1];
    const secondId = getTaskId(secondWorker);

    secondWorker.emit('message', {
      type: 'result',
      id: secondId,
      success: true,
      data: ['second-ok'],
    });

    await expect(secondTask).resolves.toEqual(['second-ok']);
  });

  it('logs terminate failures during shutdown', async () => {
    const manager = createManager(1);
    workerInstances[0].terminate.mockRejectedValueOnce(new Error('terminate failed'));

    await manager.shutdown();

    expect(logger.error).toHaveBeenCalledWith(
      '[FileTasks] Failed to terminate worker during shutdown:',
      expect.any(Error)
    );
  });
});
