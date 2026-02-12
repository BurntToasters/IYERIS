import { twemojiImg } from './rendererUtils.js';

const INDEX_STATUS_POLL_MS = 500;

interface IndexerConfig {
  getShowToast: () => (message: string, title: string, type: string) => void;
}

export function createIndexerController(config: IndexerConfig) {
  let indexStatusInterval: NodeJS.Timeout | null = null;

  function startIndexStatusPolling() {
    stopIndexStatusPolling();
    indexStatusInterval = setInterval(async () => {
      await updateIndexStatus();
      const result = await window.electronAPI.getIndexStatus();
      if (result.success && result.status && !result.status.isIndexing) {
        stopIndexStatusPolling();
      }
    }, INDEX_STATUS_POLL_MS);
  }

  function stopIndexStatusPolling() {
    if (indexStatusInterval) {
      clearInterval(indexStatusInterval);
      indexStatusInterval = null;
    }
  }

  async function updateIndexStatus() {
    const indexStatus = document.getElementById('index-status');
    if (!indexStatus) return;

    try {
      const result = await window.electronAPI.getIndexStatus();
      if (result.success && result.status) {
        const status = result.status;
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
      } else {
        indexStatus.textContent = 'Status: Unknown';
      }
    } catch (error) {
      console.error('Failed to get index status:', error);
      indexStatus.textContent = 'Status: Error';
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
      if (result.success) {
        config.getShowToast()('Index rebuild started', 'File Indexer', 'success');
        setTimeout(async () => {
          await updateIndexStatus();
        }, 300);
      } else {
        config.getShowToast()('Failed to rebuild index: ' + result.error, 'Error', 'error');
      }
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
