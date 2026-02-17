import type { ItemProperties } from './types';
import { escapeHtml, getErrorMessage } from './shared.js';
import { twemojiImg } from './rendererUtils.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

type PropertiesDialogDeps = {
  showToast: (message: string, title: string, type: ToastType) => void;
  onModalOpen: (modal: HTMLElement) => void;
  onModalClose: (modal: HTMLElement) => void;
};

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 bytes';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(2);
  return `${bytes.toLocaleString()} bytes (${size} ${units[i]})`;
}

function formatTypeSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function createOperationId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function createPropertiesDialogController(deps: PropertiesDialogDeps) {
  let activeCleanup: (() => void) | null = null;

  const clearActive = () => {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
  };

  const showPropertiesDialog = (props: ItemProperties): void => {
    clearActive();

    const modal = document.getElementById('properties-modal');
    const content = document.getElementById('properties-content');

    if (!modal || !content) return;

    const folderSizeOperationId = createOperationId('foldersize');
    const checksumOperationId = createOperationId('checksum');

    let folderSizeActive = false;
    let checksumActive = false;
    let folderSizeProgressCleanup: (() => void) | null = null;
    let checksumProgressCleanup: (() => void) | null = null;

    const sizeDisplay = formatSize(props.size);

    let html = `
    <div class="property-row">
      <div class="property-label">Name:</div>
      <div class="property-value">${escapeHtml(props.name)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Type:</div>
      <div class="property-value">${props.isDirectory ? 'Folder' : 'File'}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Size:</div>
      <div class="property-value" id="props-size-value">${sizeDisplay}</div>
    </div>`;

    if (props.isDirectory) {
      html += `
    <div class="property-row property-folder-size">
      <div class="property-label">Contents:</div>
      <div class="property-value">
        <span id="folder-size-info">Not calculated</span>
        <button class="property-btn" id="calculate-folder-size-btn">${twemojiImg(String.fromCodePoint(0x1f4ca), 'twemoji')} Calculate Size</button>
      </div>
    </div>
    <div class="property-row" id="folder-size-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="folder-size-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="folder-size-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-folder-size-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="folder-stats-row" style="display: none;">
      <div class="property-label">File Types:</div>
      <div class="property-value">
        <div id="folder-stats-content" class="folder-stats-content"></div>
      </div>
    </div>`;
    }

    html += `
    <div class="property-row">
      <div class="property-label">Location:</div>
      <div class="property-value property-path">${escapeHtml(props.path)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Created:</div>
      <div class="property-value">${new Date(props.created).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Modified:</div>
      <div class="property-value">${new Date(props.modified).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Accessed:</div>
      <div class="property-value">${new Date(props.accessed).toLocaleString()}</div>
    </div>`;

    if (props.isFile) {
      html += `
    <div class="property-separator"></div>
    <div class="property-row property-checksum-header">
      <div class="property-label">Checksums:</div>
      <div class="property-value">
        <button class="property-btn" id="calculate-checksum-btn">${twemojiImg(String.fromCodePoint(0x1f510), 'twemoji')} Calculate Checksums</button>
      </div>
    </div>
    <div class="property-row" id="checksum-progress-row" style="display: none;">
      <div class="property-label"></div>
      <div class="property-value">
        <div class="property-progress-container">
          <div class="property-progress-bar" id="checksum-progress-bar"></div>
        </div>
        <div class="property-progress-text" id="checksum-progress-text">Calculating...</div>
        <button class="property-btn property-btn-cancel" id="cancel-checksum-btn">${twemojiImg(String.fromCodePoint(0x274c), 'twemoji')} Cancel</button>
      </div>
    </div>
    <div class="property-row" id="checksum-md5-row" style="display: none;">
      <div class="property-label">MD5:</div>
      <div class="property-value property-checksum">
        <code id="checksum-md5-value"></code>
        <button class="property-btn-copy" id="copy-md5-btn" title="Copy MD5">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>
    <div class="property-row" id="checksum-sha256-row" style="display: none;">
      <div class="property-label">SHA-256:</div>
      <div class="property-value property-checksum">
        <code id="checksum-sha256-value"></code>
        <button class="property-btn-copy" id="copy-sha256-btn" title="Copy SHA-256">${twemojiImg(String.fromCodePoint(0x1f4cb), 'twemoji')}</button>
      </div>
    </div>`;
    }

    content.innerHTML = html;
    modal.style.display = 'flex';
    deps.onModalOpen(modal);

    const cleanup = () => {
      if (folderSizeActive) {
        window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
        folderSizeActive = false;
      }
      if (checksumActive) {
        window.electronAPI.cancelChecksumCalculation(checksumOperationId);
        checksumActive = false;
      }
      if (folderSizeProgressCleanup) {
        folderSizeProgressCleanup();
        folderSizeProgressCleanup = null;
      }
      if (checksumProgressCleanup) {
        checksumProgressCleanup();
        checksumProgressCleanup = null;
      }
      activeCleanup = null;
    };

    activeCleanup = cleanup;

    const closeModal = () => {
      cleanup();
      modal.style.display = 'none';
      deps.onModalClose(modal);
    };

    if (props.isDirectory) {
      const calculateBtn = document.getElementById('calculate-folder-size-btn');
      const cancelBtn = document.getElementById('cancel-folder-size-btn');
      const progressRow = document.getElementById('folder-size-progress-row');
      const progressBar = document.getElementById('folder-size-progress-bar');
      const progressText = document.getElementById('folder-size-progress-text');
      const sizeInfo = document.getElementById('folder-size-info');

      if (calculateBtn) {
        calculateBtn.addEventListener('click', async () => {
          calculateBtn.style.display = 'none';
          if (progressRow) progressRow.style.display = 'flex';
          folderSizeActive = true;

          folderSizeProgressCleanup = window.electronAPI.onFolderSizeProgress((progress) => {
            if (progress.operationId === folderSizeOperationId && progressBar && progressText) {
              const currentSize = formatSize(progress.calculatedSize);
              progressText.textContent = `${progress.fileCount} files, ${progress.folderCount} folders - ${currentSize}`;
              progressBar.style.width = '100%';
              progressBar.classList.add('indeterminate');
            }
          });

          try {
            const result = await window.electronAPI.calculateFolderSize(
              props.path,
              folderSizeOperationId
            );

            if (!result.success) {
              if (result.error !== 'Calculation cancelled') {
                if (sizeInfo) sizeInfo.textContent = `Error: ${result.error || 'Operation failed'}`;
              }
            } else {
              const folderResult = result.result;
              const totalSize = formatSize(folderResult.totalSize);
              if (sizeInfo) {
                sizeInfo.textContent = `${folderResult.fileCount} files, ${folderResult.folderCount} folders (${totalSize})`;
              }
              const propsSize = document.getElementById('props-size-value');
              if (propsSize) {
                propsSize.textContent = totalSize;
              }

              if (folderResult.fileTypes && folderResult.fileTypes.length > 0) {
                const statsRow = document.getElementById('folder-stats-row');
                const statsContent = document.getElementById('folder-stats-content');
                if (statsRow && statsContent) {
                  statsRow.style.display = 'flex';
                  statsContent.innerHTML = folderResult.fileTypes
                    .map((ft) => {
                      const pct =
                        folderResult.totalSize > 0
                          ? ((ft.size / folderResult.totalSize) * 100).toFixed(1)
                          : '0';
                      return `<div class="file-type-stat">
                    <span class="file-type-ext">${escapeHtml(ft.extension)}</span>
                    <span class="file-type-count">${ft.count} files</span>
                    <span class="file-type-size">${formatTypeSize(ft.size)} (${pct}%)</span>
                    <div class="file-type-bar" style="width: ${pct}%"></div>
                  </div>`;
                    })
                    .join('');
                }
              }
            }
          } catch (error) {
            if (sizeInfo) sizeInfo.textContent = `Error: ${getErrorMessage(error)}`;
          } finally {
            folderSizeActive = false;
            if (folderSizeProgressCleanup) {
              folderSizeProgressCleanup();
              folderSizeProgressCleanup = null;
            }
            if (progressRow) progressRow.style.display = 'none';
            if (progressBar) {
              progressBar.classList.remove('indeterminate');
              progressBar.style.width = '0%';
            }
          }
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (folderSizeActive) {
            window.electronAPI.cancelFolderSizeCalculation(folderSizeOperationId);
            folderSizeActive = false;
          }
          if (folderSizeProgressCleanup) {
            folderSizeProgressCleanup();
            folderSizeProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (calculateBtn) calculateBtn.style.display = 'inline-flex';
          if (sizeInfo) sizeInfo.textContent = 'Calculation cancelled';
        });
      }
    }

    if (props.isFile) {
      const calculateBtn = document.getElementById('calculate-checksum-btn');
      const cancelBtn = document.getElementById('cancel-checksum-btn');
      const progressRow = document.getElementById('checksum-progress-row');
      const progressBar = document.getElementById('checksum-progress-bar');
      const progressText = document.getElementById('checksum-progress-text');
      const md5Row = document.getElementById('checksum-md5-row');
      const sha256Row = document.getElementById('checksum-sha256-row');
      const md5Value = document.getElementById('checksum-md5-value');
      const sha256Value = document.getElementById('checksum-sha256-value');
      const copyMd5Btn = document.getElementById('copy-md5-btn');
      const copySha256Btn = document.getElementById('copy-sha256-btn');

      if (calculateBtn) {
        calculateBtn.addEventListener('click', async () => {
          calculateBtn.style.display = 'none';
          if (progressRow) progressRow.style.display = 'flex';
          checksumActive = true;

          checksumProgressCleanup = window.electronAPI.onChecksumProgress((progress) => {
            if (progress.operationId === checksumOperationId && progressBar && progressText) {
              progressBar.style.width = `${progress.percent}%`;
              progressText.textContent = `Calculating ${progress.algorithm.toUpperCase()}... ${progress.percent.toFixed(1)}%`;
            }
          });

          try {
            const result = await window.electronAPI.calculateChecksum(
              props.path,
              checksumOperationId,
              ['md5', 'sha256']
            );

            if (!result.success) {
              if (result.error !== 'Calculation cancelled') {
                deps.showToast(result.error || 'Checksum calculation failed', 'Error', 'error');
              }
            } else {
              if (result.result.md5 && md5Row && md5Value) {
                md5Value.textContent = result.result.md5;
                md5Row.style.display = 'flex';
              }
              if (result.result.sha256 && sha256Row && sha256Value) {
                sha256Value.textContent = result.result.sha256;
                sha256Row.style.display = 'flex';
              }
            }
          } catch (error) {
            deps.showToast(getErrorMessage(error), 'Error', 'error');
          } finally {
            checksumActive = false;
            if (checksumProgressCleanup) {
              checksumProgressCleanup();
              checksumProgressCleanup = null;
            }
            if (progressRow) progressRow.style.display = 'none';
            if (progressBar) progressBar.style.width = '0%';
          }
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (checksumActive) {
            window.electronAPI.cancelChecksumCalculation(checksumOperationId);
            checksumActive = false;
          }
          if (checksumProgressCleanup) {
            checksumProgressCleanup();
            checksumProgressCleanup = null;
          }
          if (progressRow) progressRow.style.display = 'none';
          if (calculateBtn) calculateBtn.style.display = 'inline-flex';
        });
      }

      if (copyMd5Btn && md5Value) {
        copyMd5Btn.addEventListener('click', () => {
          navigator.clipboard.writeText(md5Value.textContent || '');
          deps.showToast('MD5 copied to clipboard', 'Copied', 'success');
        });
      }

      if (copySha256Btn && sha256Value) {
        copySha256Btn.addEventListener('click', () => {
          navigator.clipboard.writeText(sha256Value.textContent || '');
          deps.showToast('SHA-256 copied to clipboard', 'Copied', 'success');
        });
      }
    }

    const propsCloseBtn = document.getElementById('properties-close');
    const propsOkBtn = document.getElementById('properties-ok');
    if (propsCloseBtn) propsCloseBtn.onclick = closeModal;
    if (propsOkBtn) propsOkBtn.onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };
  };

  return {
    showPropertiesDialog,
    cleanup: clearActive,
  };
}
