import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from './utils/logger';

type TaskType =
  | 'build-index'
  | 'search-files'
  | 'search-content'
  | 'search-content-list'
  | 'search-content-index'
  | 'search-index'
  | 'folder-size'
  | 'checksum'
  | 'load-index'
  | 'save-index'
  | 'list-directory';

interface TaskRequest {
  id: string;
  type: TaskType;
  payload: unknown;
  operationId?: string;
}

interface TaskResult {
  type: 'result';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface TaskProgress {
  type: 'progress';
  task: TaskType;
  operationId: string;
  data: unknown;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  currentTaskId?: string;
  currentOperationId?: string;
}

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  operationId?: string;
}

export class FileTaskManager extends EventEmitter {
  private workers: WorkerState[] = [];
  private queue: TaskRequest[] = [];
  private pending = new Map<string, PendingTask>();
  private nextId = 0;
  private shuttingDown = false;
  private static readonly MAX_QUEUE_SIZE = 1000;

  constructor(workerCount: number = FileTaskManager.getDefaultWorkerCount()) {
    super();
    const count = Math.max(1, workerCount);
    for (let i = 0; i < count; i++) {
      this.workers.push(this.createWorker());
    }
  }

  async runTask<T>(type: TaskType, payload: unknown, operationId?: string): Promise<T> {
    const id = `${Date.now()}-${this.nextId++}`;
    const task: TaskRequest = { id, type, payload, operationId };

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length + this.pending.size >= FileTaskManager.MAX_QUEUE_SIZE) {
        reject(new Error('Task queue is full'));
        return;
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, operationId });
      this.queue.push(task);
      this.drain();
    });
  }

  cancelOperation(operationId: string): void {
    for (const workerState of this.workers) {
      workerState.worker.postMessage({ type: 'cancel', operationId });
    }

    const remaining: TaskRequest[] = [];
    for (const task of this.queue) {
      if (task.operationId === operationId) {
        const pending = this.pending.get(task.id);
        if (pending) {
          pending.reject(new Error('Calculation cancelled'));
          this.pending.delete(task.id);
        }
      } else {
        remaining.push(task);
      }
    }
    this.queue = remaining;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const shutdownError = new Error('File task manager shutting down');
    for (const pending of this.pending.values()) {
      pending.reject(shutdownError);
    }
    this.pending.clear();
    this.queue = [];
    await Promise.all(
      this.workers.map((workerState) =>
        workerState.worker.terminate().catch((error) => {
          logger.error('[FileTasks] Failed to terminate worker during shutdown:', error);
        })
      )
    );
  }

  private drain(): void {
    for (const workerState of this.workers) {
      if (workerState.busy) continue;
      const task = this.queue.shift();
      if (!task) return;
      this.dispatch(workerState, task);
    }
  }

  private dispatch(workerState: WorkerState, task: TaskRequest): void {
    workerState.busy = true;
    workerState.currentTaskId = task.id;
    workerState.currentOperationId = task.operationId;
    workerState.worker.postMessage(task);
  }

  private createWorker(): WorkerState {
    const workerPath = path.join(__dirname, 'workers', 'fileTasks.js');
    const worker = new Worker(workerPath);
    const workerState: WorkerState = { worker, busy: false };

    worker.on('message', (message: TaskProgress | TaskResult) => {
      if (message.type === 'progress') {
        this.emit('progress', message);
        return;
      }

      if (message.type === 'result') {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.finishWorkerTask(workerState);
          return;
        }
        this.pending.delete(message.id);
        this.finishWorkerTask(workerState);
        if (message.success) {
          pending.resolve(message.data);
        } else {
          pending.reject(new Error(message.error || 'Task failed'));
        }
      }
    });

    worker.on('error', (error: Error) => {
      this.handleWorkerFailure(workerState, error);
    });

    worker.on('exit', (code) => {
      if (this.shuttingDown) return;
      if (code !== 0) {
        this.handleWorkerFailure(workerState, new Error(`Worker exited with code ${code}`));
      }
    });

    return workerState;
  }

  private static getDefaultWorkerCount(): number {
    const cpuCount = Math.max(1, os.cpus().length);
    const totalMemGb = os.totalmem() / 1024 ** 3;
    const maxWorkers = totalMemGb < 6 ? 2 : totalMemGb < 12 ? 6 : totalMemGb < 24 ? 12 : 16;
    return Math.max(1, Math.min(cpuCount, maxWorkers));
  }

  private handleWorkerFailure(workerState: WorkerState, error: Error): void {
    if (this.shuttingDown) return;

    const taskId = workerState.currentTaskId;
    if (taskId) {
      const pending = this.pending.get(taskId);
      if (pending) {
        pending.reject(error);
        this.pending.delete(taskId);
      }
    }
    workerState.busy = true;
    workerState.currentTaskId = undefined;
    workerState.currentOperationId = undefined;
    workerState.worker.removeAllListeners();
    workerState.worker.terminate().catch((error) => {
      logger.error('[FileTasks] Failed to terminate worker during replacement:', error);
    });

    const index = this.workers.indexOf(workerState);
    if (index < 0) {
      return;
    }
    const replacement = this.createWorker();
    this.workers[index] = replacement;
    this.drain();
  }

  private finishWorkerTask(workerState: WorkerState): void {
    workerState.busy = false;
    workerState.currentTaskId = undefined;
    workerState.currentOperationId = undefined;
    this.drain();
  }
}
