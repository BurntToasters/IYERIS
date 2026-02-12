import { parentPort } from 'worker_threads';
import { type TaskType, isRecord, getErrorMessage, cancelled, pruneCancelled } from './workerUtils';
import {
  searchDirectoryFiles,
  searchDirectoryContent,
  searchContentList,
  searchContentIndex,
  searchIndexFile,
} from './searchTasks';
import { calculateFolderSize, calculateChecksum } from './computeTasks';
import { buildIndex, loadIndexFile, saveIndexFile } from './indexTasks';
import { listDirectory } from './listDirectoryTask';

const TASK_TYPES = [
  'build-index',
  'search-files',
  'search-content',
  'search-content-list',
  'search-content-index',
  'search-index',
  'folder-size',
  'checksum',
  'load-index',
  'save-index',
  'list-directory',
] as const;

const TASK_TYPE_SET = new Set<TaskType>(TASK_TYPES);

interface TaskRequest {
  id: string;
  type: TaskType;
  payload: unknown;
  operationId?: string;
}

function isTaskRequest(value: unknown): value is TaskRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    TASK_TYPE_SET.has(value.type as TaskType) &&
    Object.prototype.hasOwnProperty.call(value, 'payload')
  );
}

const taskHandlers: Record<TaskType, (payload: unknown, operationId?: string) => Promise<unknown>> =
  {
    'search-files': (payload, operationId) =>
      searchDirectoryFiles(payload as Parameters<typeof searchDirectoryFiles>[0], operationId),
    'search-content': (payload, operationId) =>
      searchDirectoryContent(payload as Parameters<typeof searchDirectoryContent>[0], operationId),
    'search-content-list': (payload, operationId) =>
      searchContentList(payload as Parameters<typeof searchContentList>[0], operationId),
    'search-content-index': (payload, operationId) =>
      searchContentIndex(payload as Parameters<typeof searchContentIndex>[0], operationId),
    'search-index': (payload, operationId) =>
      searchIndexFile(payload as Parameters<typeof searchIndexFile>[0], operationId),
    'folder-size': (payload, operationId) =>
      calculateFolderSize(payload as Parameters<typeof calculateFolderSize>[0], operationId),
    checksum: (payload, operationId) =>
      calculateChecksum(payload as Parameters<typeof calculateChecksum>[0], operationId),
    'build-index': (payload, operationId) =>
      buildIndex(payload as Parameters<typeof buildIndex>[0], operationId),
    'load-index': (payload) => loadIndexFile(payload as Parameters<typeof loadIndexFile>[0]),
    'save-index': (payload) => saveIndexFile(payload as Parameters<typeof saveIndexFile>[0]),
    'list-directory': (payload, operationId) =>
      listDirectory(payload as Parameters<typeof listDirectory>[0], operationId),
  };

async function handleTask(message: TaskRequest): Promise<unknown> {
  return taskHandlers[message.type](message.payload, message.operationId);
}

if (!parentPort) {
  process.exit(1);
}

parentPort.on('message', async (message: unknown) => {
  if (isRecord(message) && message.type === 'cancel' && typeof message.operationId === 'string') {
    cancelled.set(message.operationId, Date.now());
    pruneCancelled();
    return;
  }

  if (!isRecord(message) || !isTaskRequest(message)) return;
  const task = message;
  try {
    const data = await handleTask(task);
    parentPort?.postMessage({
      type: 'result',
      id: task.id,
      success: true,
      data,
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'result',
      id: task.id,
      success: false,
      error: getErrorMessage(error),
    });
  } finally {
    if (task.operationId) {
      cancelled.delete(task.operationId);
    }
  }
});
