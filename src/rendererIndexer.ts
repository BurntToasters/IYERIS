import { twemojiImg } from './rendererUtils.js';
import { INDEX_REBUILD_DELAY_MS } from './rendererLocalConstants.js';

const INDEX_STATUS_POLL_MS = 1500;

type IndexStatusSnapshot = {
  isIndexing: boolean;
  indexedFiles: number;
  lastIndexTime?: string | number | null;
};

interface IndexerConfig {
  getShowToast: () => (message: string, title: string, type: string) => void;
}

export function createIndexerController(config: IndexerConfig) {
  let indexStatusInterval: NodeJS.Timeout | null = null;
  let consecutiveErrors = 0;
  let pollInFlight = false;
  const MAX_CONSECUTIVE_ERRORS = 10;

  function startIndexStatusPolling() {
    stopIndexStatusPolling();
    consecutiveErrors = 0;
    const runPoll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const status = await updateIndexStatus();
        if (status && !status.isIndexing) {
          stopIndexStatusPolling();
        }
      } finally {
        pollInFlight = false;
      }
    };

    indexStatusInterval = setInterval(() => {
      void runPoll();
    }, INDEX_STATUS_POLL_MS);
    void runPoll();
  }

  function stopIndexStatusPolling() {
    if (indexStatusInterval) {
      clearInterval(indexStatusInterval);
      indexStatusInterval = null;
    }
    pollInFlight = false;
    consecutiveErrors = 0;
  }

  async function updateIndexStatus(): Promise<IndexStatusSnapshot | null> {
    const indexStatus = document.getElementById('index-status');
    if (!indexStatus) return null;

    try {
      const result = await window.electronAPI.getIndexStatus();
      if (!result.success) {
        indexStatus.textContent = 'Status: Unknown';
        return null;
      }
      const status = result.status as IndexStatusSnapshot;
      if (status.isIndexing) {
        indexStatus.textContent = `Status: Indexing... (${status.indexedFiles.toLocaleString()} files found)`;
        if (!indexStatusInterval) {
          startIndexStatusPolling();
        }
      } else if (status.lastIndexTime) {
        const date = new Date(status.lastIndexTime);
        indexStatus.textContent = `Status: ${status.indexedFiles.toLocaleString()} files indexed on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
      } else {
        indexStatus.textContent = 'Status: Not indexed yet';
      }
      return status;
    } catch (error) {
      console.error('Failed to get index status:', error);
      indexStatus.textContent = 'Status: Error';
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopIndexStatusPolling();
      }
      return null;
    }
  }

  async function rebuildIndex() {
    const rebuildBtn = document.getElementById('rebuild-index-btn') as HTMLButtonElement;
    if (!rebuildBtn) return;

    const originalHTML = rebuildBtn.innerHTML;
    rebuildBtn.disabled = true;
    rebuildBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x23f3), 'twemoji')} Rebuilding...`;

    try {
      const result = await window.electronAPI.rebuildIndex();
      if (!result.success) {
        config.getShowToast()(
          'Failed to rebuild index: ' + (result.error || 'Operation failed'),
          'Error',
          'error'
        );
        return;
      }
      config.getShowToast()('Index rebuild started', 'File Indexer', 'success');
      startIndexStatusPolling();
      setTimeout(async () => {
        await updateIndexStatus();
      }, INDEX_REBUILD_DELAY_MS);
    } catch {
      config.getShowToast()('Error rebuilding index', 'Error', 'error');
    } finally {
      rebuildBtn.disabled = false;
      rebuildBtn.innerHTML = originalHTML;
    }
  }

  return {
    startIndexStatusPolling,
    stopIndexStatusPolling,
    updateIndexStatus,
    rebuildIndex,
  };
}
