import type { FileItem } from './types';
import { ARCHIVE_SUFFIXES } from './fileTypes.js';
import { getErrorMessage } from './shared.js';
import { normalizeWindowsPath, rendererPath as path } from './rendererUtils.js';

export function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function getArchiveBaseName(filePath: string): string {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);
  if (lower.endsWith('.tar.gz')) {
    return fileName.replace(/\.tar\.gz$/i, '');
  }
  return path.basename(filePath, path.extname(filePath));
}

type CompressExtractDeps = {
  getCurrentPath: () => string;
  getSelectedItems: () => Set<string>;
  getAllFiles: () => FileItem[];
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  showConfirm: (
    message: string,
    title?: string,
    type?: 'info' | 'warning' | 'error' | 'success' | 'question'
  ) => Promise<boolean>;
  navigateTo: (path: string) => Promise<void>;
  activateModal: (el: HTMLElement) => void;
  deactivateModal: (el: HTMLElement) => void;
  addToRecentFiles: (filePath: string) => void;
  generateOperationId: () => string;
  addOperation: (id: string, type: 'compress' | 'extract', name: string) => void;
  getOperation: (id: string) => { aborted: boolean } | undefined;
  updateOperation: (id: string, current: number, total: number, currentFile: string) => void;
  removeOperation: (id: string) => void;
  isWindowsPlatform: () => boolean;
};

export function createCompressExtractController(deps: CompressExtractDeps) {
  let extractModalArchivePath: string | null = null;
  let extractModalTrackRecent = true;

  function joinFilePath(baseFolder: string, ...segments: string[]): string {
    if (!deps.isWindowsPlatform()) {
      const normalizedBase = baseFolder.replace(/\\/g, '/');
      const normalizedSegments = segments.map((segment) => segment.replace(/\\/g, '/'));
      return path.join(normalizedBase, ...normalizedSegments);
    }

    const normalizedBase = normalizeWindowsPath(baseFolder);
    let combined = normalizedBase;
    for (const segment of segments) {
      const cleaned = segment
        .replace(/[\\/]+/g, '\\')
        .replace(/^\\+/, '')
        .replace(/\\+$/, '');
      if (!cleaned) continue;
      if (!combined.endsWith('\\')) {
        combined += '\\';
      }
      combined += cleaned;
    }
    return combined;
  }

  function buildArchiveExtractPath(baseFolder: string, archivePath: string): string {
    return joinFilePath(baseFolder, getArchiveBaseName(archivePath));
  }

  async function handleCompress(
    format: string = 'zip',
    customName?: string,
    advancedOptions?: Record<string, unknown> | undefined
  ) {
    const selectedPaths = Array.from(deps.getSelectedItems());

    if (selectedPaths.length === 0) {
      deps.showToast('No items selected', 'Error', 'error');
      return;
    }

    const extensionMap: Record<string, string> = {
      zip: '.zip',
      '7z': '.7z',
      tar: '.tar',
      'tar.gz': '.tar.gz',
    };

    const extension = extensionMap[format] || '.zip';

    let archiveName: string;
    if (customName) {
      archiveName = customName;
    } else if (selectedPaths.length === 1) {
      const itemName = path.basename(selectedPaths[0]);
      const nameWithoutExt = itemName.replace(/\.[^/.]+$/, '');
      archiveName = `${nameWithoutExt}${extension}`;
    } else {
      const folderName = path.basename(deps.getCurrentPath());
      archiveName = `${folderName}_${selectedPaths.length}_items${extension}`;
    }

    const outputPath = path.join(deps.getCurrentPath(), archiveName);

    const existingFile = deps.getAllFiles().find((f) => f.name === archiveName);
    if (existingFile) {
      const overwrite = await deps.showConfirm(
        `"${archiveName}" already exists. Overwrite it?`,
        'File Exists',
        'warning'
      );
      if (!overwrite) return;
    }

    const operationId = deps.generateOperationId();

    deps.addOperation(operationId, 'compress', archiveName);

    const progressHandler = (progress: {
      operationId?: string;
      current: number;
      total: number;
      name: string;
    }) => {
      if (progress.operationId === operationId) {
        const operation = deps.getOperation(operationId);
        if (operation && !operation.aborted) {
          deps.updateOperation(operationId, progress.current, progress.total, progress.name);
        }
      }
    };

    const cleanupProgressHandler = window.electronAPI.onCompressProgress(progressHandler);

    try {
      const operation = deps.getOperation(operationId);
      if (operation?.aborted) {
        cleanupProgressHandler();
        deps.removeOperation(operationId);
        return;
      }

      const result = await window.electronAPI.compressFiles(
        selectedPaths,
        outputPath,
        format,
        operationId,
        advancedOptions
      );

      cleanupProgressHandler();
      deps.removeOperation(operationId);

      if (!result.success) {
        deps.showToast(result.error || 'Compression failed', 'Error', 'error');
        return;
      }
      deps.showToast(`Created ${archiveName}`, 'Compressed Successfully', 'success');
      await deps.navigateTo(deps.getCurrentPath());
    } catch (error) {
      cleanupProgressHandler();
      deps.removeOperation(operationId);
      deps.showToast(getErrorMessage(error), 'Compression Error', 'error');
    }
  }

  // ── Advanced Compress Options Modal ──────────────────────────────────────

  function getCompressOptionsElements() {
    return {
      modal: document.getElementById('compress-options-modal') as HTMLElement | null,
      nameInput: document.getElementById('compress-archive-name') as HTMLInputElement | null,
      formatSelect: document.getElementById('compress-format') as HTMLSelectElement | null,
      levelSelect: document.getElementById('compress-level') as HTMLSelectElement | null,
      methodSelect: document.getElementById('compress-method') as HTMLSelectElement | null,
      methodField: document.getElementById('compress-method-field') as HTMLElement | null,
      dictionarySelect: document.getElementById('compress-dictionary') as HTMLSelectElement | null,
      dictionaryField: document.getElementById('compress-dictionary-field') as HTMLElement | null,
      solidSelect: document.getElementById('compress-solid') as HTMLSelectElement | null,
      solidField: document.getElementById('compress-solid-field') as HTMLElement | null,
      threadsSelect: document.getElementById('compress-threads') as HTMLSelectElement | null,
      threadsField: document.getElementById('compress-threads-field') as HTMLElement | null,
      passwordInput: document.getElementById('compress-password') as HTMLInputElement | null,
      passwordConfirm: document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement | null,
      passwordToggle: document.getElementById('compress-password-toggle') as HTMLElement | null,
      encryptionFieldset: document.getElementById(
        'compress-encryption-fieldset'
      ) as HTMLElement | null,
      encryptionMethodSelect: document.getElementById(
        'compress-encryption-method'
      ) as HTMLSelectElement | null,
      encryptionMethodField: document.getElementById(
        'compress-encryption-method-field'
      ) as HTMLElement | null,
      encryptNamesCheck: document.getElementById(
        'compress-encrypt-names'
      ) as HTMLInputElement | null,
      encryptNamesField: document.getElementById(
        'compress-encrypt-names-field'
      ) as HTMLElement | null,
      splitSelect: document.getElementById('compress-split') as HTMLSelectElement | null,
      splitField: document.getElementById('compress-split-field') as HTMLElement | null,
      previewPath: document.getElementById('compress-preview-path') as HTMLElement | null,
      confirmBtn: document.getElementById('compress-options-confirm') as HTMLElement | null,
      cancelBtn: document.getElementById('compress-options-cancel') as HTMLElement | null,
      closeBtn: document.getElementById('compress-options-close') as HTMLElement | null,
    };
  }

  function updateCompressOptionsVisibility() {
    const els = getCompressOptionsElements();
    if (!els.formatSelect) return;

    const fmt = els.formatSelect.value;
    const is7z = fmt === '7z';
    const isZip = fmt === 'zip';
    const isTar = fmt === 'tar' || fmt === 'tar.gz';
    const supportsAdvanced = is7z || isZip;

    if (els.methodField) els.methodField.hidden = !supportsAdvanced;

    if (els.solidField) els.solidField.hidden = !is7z;
    if (els.threadsField) els.threadsField.hidden = isTar;

    if (els.encryptionFieldset) els.encryptionFieldset.hidden = !supportsAdvanced;

    if (els.encryptNamesField) els.encryptNamesField.hidden = !is7z;

    if (els.encryptionMethodField) els.encryptionMethodField.hidden = !isZip;

    if (els.splitField) els.splitField.hidden = isTar;

    if (els.levelSelect) {
      els.levelSelect.disabled = isTar;
      if (isTar) {
        els.levelSelect.value = '0';
      } else if (els.levelSelect.value === '0' && !els.levelSelect.dataset.userChoseStore) {
        els.levelSelect.value = '5';
      }
    }

    if (els.methodSelect) {
      const currentMethod = els.methodSelect.value;
      els.methodSelect.innerHTML = '';

      if (is7z) {
        for (const m of ['LZMA2', 'LZMA', 'PPMd', 'BZip2', 'Deflate']) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          els.methodSelect.appendChild(opt);
        }
      } else if (isZip) {
        for (const m of ['Deflate', 'Deflate64', 'BZip2', 'LZMA']) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          els.methodSelect.appendChild(opt);
        }
      }

      const options = Array.from(els.methodSelect.options);
      const match = options.find((o) => o.value === currentMethod);
      if (match) {
        els.methodSelect.value = currentMethod;
      } else if (options.length > 0) {
        els.methodSelect.value = options[0].value;
      }
    }

    const selectedMethod = els.methodSelect?.value || '';
    const dictionarySupported = is7z || (isZip && selectedMethod === 'LZMA');
    if (els.dictionaryField) els.dictionaryField.hidden = !supportsAdvanced || !dictionarySupported;
    if (!dictionarySupported && els.dictionarySelect) {
      els.dictionarySelect.value = '';
    }

    updateCompressPreviewPath();
  }

  function updateCompressPreviewPath() {
    const els = getCompressOptionsElements();
    if (!els.previewPath || !els.nameInput) return;
    let name = els.nameInput.value.trim().replace(/[/\\]/g, '_');
    if (!name) {
      const extMap: Record<string, string> = {
        zip: '.zip',
        '7z': '.7z',
        tar: '.tar',
        'tar.gz': '.tar.gz',
      };
      const ext = extMap[els.formatSelect?.value || '7z'] || '.7z';
      name = `Archive${ext}`;
    }
    els.previewPath.textContent = path.join(deps.getCurrentPath(), name);
  }

  function showCompressOptionsModal() {
    const els = getCompressOptionsElements();
    if (!els.modal || !els.nameInput || !els.formatSelect) return;

    const selectedPaths = Array.from(deps.getSelectedItems());
    if (selectedPaths.length === 0) {
      deps.showToast('No items selected', 'Error', 'error');
      return;
    }

    let baseName: string;
    if (selectedPaths.length === 1) {
      const itemName = path.basename(selectedPaths[0]);
      baseName = itemName.replace(/\.(tar\.gz|tgz|tar\.bz2|tar\.xz|[^/.]+)$/i, '');
    } else {
      baseName = `${path.basename(deps.getCurrentPath())}_${selectedPaths.length}_items`;
    }

    els.formatSelect.value = '7z';
    els.nameInput.value = `${baseName}.7z`;
    if (els.levelSelect) els.levelSelect.value = '5';
    if (els.levelSelect) delete els.levelSelect.dataset.userChoseStore;
    if (els.methodSelect) els.methodSelect.value = 'LZMA2';
    if (els.dictionarySelect) els.dictionarySelect.value = '';
    if (els.solidSelect) els.solidSelect.value = '';
    if (els.threadsSelect) els.threadsSelect.value = '';
    if (els.passwordInput) els.passwordInput.value = '';
    if (els.passwordConfirm) els.passwordConfirm.value = '';
    if (els.passwordInput) els.passwordInput.type = 'password';
    if (els.passwordConfirm) els.passwordConfirm.type = 'password';
    if (els.encryptionMethodSelect) els.encryptionMethodSelect.value = 'AES256';
    if (els.encryptNamesCheck) els.encryptNamesCheck.checked = false;
    if (els.splitSelect) els.splitSelect.value = '';

    updateCompressOptionsVisibility();

    els.modal.style.display = 'flex';
    deps.activateModal(els.modal);
    els.nameInput.focus();
    els.nameInput.select();
  }

  function hideCompressOptionsModal() {
    const els = getCompressOptionsElements();
    if (els.modal) {
      els.modal.style.display = 'none';
      deps.deactivateModal(els.modal);
    }
  }

  async function confirmCompressOptions() {
    const els = getCompressOptionsElements();
    if (!els.nameInput || !els.formatSelect) return;

    let archiveName = els.nameInput.value.trim().replace(/[/\\]/g, '_');
    if (!archiveName) {
      deps.showToast('Enter an archive name', 'Missing Name', 'warning');
      els.nameInput.focus();
      return;
    }

    const format = els.formatSelect.value;
    const isTarFormat = format === 'tar' || format === 'tar.gz';

    const extMap: Record<string, string> = {
      zip: '.zip',
      '7z': '.7z',
      tar: '.tar',
      'tar.gz': '.tar.gz',
    };
    const expectedExt = extMap[format] || '.7z';
    if (!archiveName.toLowerCase().endsWith(expectedExt)) {
      archiveName = archiveName.replace(/\.(zip|7z|tar\.gz|tgz|tar)$/i, '') + expectedExt;
    }

    const password = (!isTarFormat && els.passwordInput?.value) || '';
    const passwordConfirm = (!isTarFormat && els.passwordConfirm?.value) || '';

    if (password && password !== passwordConfirm) {
      deps.showToast('Passwords do not match', 'Password Mismatch', 'warning');
      els.passwordConfirm?.focus();
      return;
    }

    const advancedOptions: Record<string, unknown> = {};

    if (!isTarFormat) {
      const level = els.levelSelect?.value;
      if (level != null && level !== '5') {
        advancedOptions.compressionLevel = parseInt(level, 10);
      }

      const defaultMethodForFormat: Record<string, string> = { '7z': 'LZMA2', zip: 'Deflate' };
      const method = els.methodSelect?.value || defaultMethodForFormat[format] || '';
      if (method && method !== defaultMethodForFormat[format]) {
        advancedOptions.method = method;
      }

      const dict = els.dictionarySelect?.value;
      const dictionarySupported = format === '7z' || (format === 'zip' && method === 'LZMA');
      if (dict && dictionarySupported) advancedOptions.dictionarySize = dict;

      if (format === '7z') {
        const solid = els.solidSelect?.value;
        if (solid) advancedOptions.solidBlockSize = solid;
      }

      const threads = els.threadsSelect?.value;
      if (threads) advancedOptions.cpuThreads = threads;
    }

    if (password) {
      advancedOptions.password = password;
      if (format === '7z' && els.encryptNamesCheck?.checked) {
        advancedOptions.encryptFileNames = true;
      }
      if (format === 'zip') {
        advancedOptions.encryptionMethod = els.encryptionMethodSelect?.value || 'AES256';
      }
    }

    if (!isTarFormat) {
      const split = els.splitSelect?.value;
      if (split) advancedOptions.splitVolume = split;
    }

    hideCompressOptionsModal();
    await handleCompress(
      format,
      archiveName,
      Object.keys(advancedOptions).length > 0 ? advancedOptions : undefined
    );
  }

  function setupCompressOptionsModal() {
    const els = getCompressOptionsElements();
    if (!els.modal) return;

    els.confirmBtn?.addEventListener('click', () => {
      void confirmCompressOptions();
    });

    els.cancelBtn?.addEventListener('click', hideCompressOptionsModal);
    els.closeBtn?.addEventListener('click', hideCompressOptionsModal);

    els.modal.addEventListener('click', (e) => {
      if (e.target === els.modal) hideCompressOptionsModal();
    });

    els.formatSelect?.addEventListener('change', () => {
      const extMap: Record<string, string> = {
        zip: '.zip',
        '7z': '.7z',
        tar: '.tar',
        'tar.gz': '.tar.gz',
      };
      const ext = extMap[els.formatSelect!.value] || '.7z';
      if (els.nameInput) {
        const current = els.nameInput.value;
        const withoutExt = current.replace(/\.(zip|7z|tar\.gz|tgz|tar)$/i, '');
        els.nameInput.value = `${withoutExt}${ext}`;
      }
      if (els.levelSelect) delete els.levelSelect.dataset.userChoseStore;
      updateCompressOptionsVisibility();
    });

    els.nameInput?.addEventListener('input', updateCompressPreviewPath);
    els.methodSelect?.addEventListener('change', updateCompressOptionsVisibility);

    els.levelSelect?.addEventListener('change', () => {
      if (els.levelSelect) {
        els.levelSelect.dataset.userChoseStore = els.levelSelect.value === '0' ? '1' : '';
      }
    });

    els.passwordToggle?.addEventListener('click', () => {
      if (els.passwordInput) {
        const show = els.passwordInput.type === 'password';
        els.passwordInput.type = show ? 'text' : 'password';
        if (els.passwordConfirm) {
          els.passwordConfirm.type = show ? 'text' : 'password';
        }
        if (els.passwordToggle) {
          els.passwordToggle.title = show ? 'Hide password' : 'Show password';
        }
      }
    });

    els.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hideCompressOptionsModal();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'SELECT') {
          e.preventDefault();
          void confirmCompressOptions();
        }
      }
    });
  }

  function updateExtractPreview(baseFolder: string): void {
    const preview = document.getElementById('extract-preview-path');
    if (!preview || !extractModalArchivePath) return;
    if (!baseFolder) {
      preview.textContent = '';
      return;
    }
    preview.textContent = buildArchiveExtractPath(baseFolder, extractModalArchivePath);
  }

  function showExtractModal(
    archivePath: string,
    archiveName?: string,
    trackRecent: boolean = true
  ): void {
    const modal = document.getElementById('extract-modal') as HTMLElement | null;
    const message = document.getElementById('extract-modal-message') as HTMLElement | null;
    const input = document.getElementById('extract-destination-input') as HTMLInputElement | null;

    if (!modal || !message || !input) return;

    const name = archiveName || path.basename(archivePath);
    extractModalArchivePath = archivePath;
    extractModalTrackRecent = trackRecent;

    const baseFolder = path.dirname(archivePath);
    input.value = baseFolder;
    message.textContent = `Extract ${name}?`;
    updateExtractPreview(baseFolder);

    modal.style.display = 'flex';
    deps.activateModal(modal);
    input.focus();
    input.select();
  }

  function hideExtractModal(): void {
    const modal = document.getElementById('extract-modal') as HTMLElement | null;
    if (modal) {
      modal.style.display = 'none';
      deps.deactivateModal(modal);
    }
    extractModalArchivePath = null;
    extractModalTrackRecent = true;
  }

  async function openPathWithArchivePrompt(
    filePath: string,
    fileName?: string,
    trackRecent: boolean = true
  ): Promise<void> {
    if (!filePath) return;
    if (isArchivePath(filePath)) {
      showExtractModal(filePath, fileName, trackRecent);
      return;
    }
    await window.electronAPI.openFile(filePath);
    if (trackRecent) {
      deps.addToRecentFiles(filePath);
    }
  }

  async function openFileEntry(item: FileItem): Promise<void> {
    if (item.isDirectory) {
      deps.navigateTo(item.path);
      return;
    }
    await openPathWithArchivePrompt(item.path, item.name);
  }

  async function confirmExtractModal(): Promise<void> {
    const input = document.getElementById('extract-destination-input') as HTMLInputElement | null;
    if (!input || !extractModalArchivePath) return;
    const baseFolder = input.value.trim();
    if (!baseFolder) {
      deps.showToast('Choose a destination folder', 'Missing Destination', 'warning');
      input.focus();
      return;
    }
    const archivePath = extractModalArchivePath;
    const trackRecent = extractModalTrackRecent;
    hideExtractModal();
    await handleExtract(archivePath, baseFolder, trackRecent);
  }

  async function handleExtract(
    archivePath: string,
    destBaseFolder: string,
    trackRecent: boolean = true
  ) {
    const baseFolder = destBaseFolder.trim();
    if (!baseFolder) {
      deps.showToast('Choose a destination folder', 'Missing Destination', 'warning');
      return;
    }

    if (!isArchivePath(archivePath)) {
      deps.showToast(
        'Unsupported archive format. Supported: .zip, .7z, .rar, .tar.gz, and more',
        'Error',
        'error'
      );
      return;
    }

    const baseName = getArchiveBaseName(archivePath);
    const destPath = buildArchiveExtractPath(baseFolder, archivePath);
    const operationId = deps.generateOperationId();

    deps.addOperation(operationId, 'extract', baseName);

    const progressHandler = (progress: {
      operationId?: string;
      current: number;
      total: number;
      name: string;
    }) => {
      if (progress.operationId === operationId) {
        const operation = deps.getOperation(operationId);
        if (operation && !operation.aborted) {
          deps.updateOperation(operationId, progress.current, progress.total, progress.name);
        }
      }
    };

    const cleanupProgressHandler = window.electronAPI.onExtractProgress(progressHandler);

    try {
      const operation = deps.getOperation(operationId);
      if (operation?.aborted) {
        cleanupProgressHandler();
        deps.removeOperation(operationId);
        return;
      }

      const result = await window.electronAPI.extractArchive(archivePath, destPath, operationId);

      cleanupProgressHandler();
      deps.removeOperation(operationId);

      if (!result.success) {
        deps.showToast(result.error || 'Extraction failed', 'Error', 'error');
        return;
      }
      deps.showToast(`Extracted to ${destPath}`, 'Extraction Complete', 'success');
      if (trackRecent) {
        deps.addToRecentFiles(archivePath);
      }
      if (deps.getCurrentPath() === baseFolder) {
        await deps.navigateTo(deps.getCurrentPath());
      }
    } catch (error) {
      cleanupProgressHandler();
      deps.removeOperation(operationId);
      deps.showToast(getErrorMessage(error), 'Extraction Error', 'error');
    }
  }

  return {
    handleCompress,
    showCompressOptionsModal,
    hideCompressOptionsModal,
    showExtractModal,
    hideExtractModal,
    openPathWithArchivePrompt,
    openFileEntry,
    confirmExtractModal,
    updateExtractPreview,
    setupCompressOptionsModal,
  };
}
