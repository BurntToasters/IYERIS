import type { CodeSignatureInfo, CodeSigner, ItemProperties } from './types';
import { escapeHtml, getErrorMessage, ignoreError } from './shared.js';
import { rendererPath, twemojiImg } from './rendererUtils.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

type PropertiesDialogDeps = {
  showToast: (message: string, title: string, type: ToastType) => void;
  onModalOpen: (modal: HTMLElement) => void;
  onModalClose: (modal: HTMLElement) => void;
  getFileIcon: (name: string) => string;
  getThumbnailForPath: (path: string) => string | undefined;
  getFileTypeFromName: (name: string) => string;
};

type ChecksumAlgorithm = 'md5' | 'sha256' | 'sha512' | 'blake3' | 'crc32';

type OperationRun = { id: string; unlisten: () => void };

const CHECKSUM_ALGORITHMS: readonly ChecksumAlgorithm[] = [
  'md5',
  'sha256',
  'sha512',
  'blake3',
  'crc32',
];

const CHECKSUM_LABELS: Record<ChecksumAlgorithm, string> = {
  md5: 'MD5',
  sha256: 'SHA-256',
  sha512: 'SHA-512',
  blake3: 'BLAKE3',
  crc32: 'CRC32',
};

const TAG_COLORS: Record<string, string> = {
  Red: '#ff3b30',
  Orange: '#ff9500',
  Yellow: '#ffcc00',
  Green: '#34c759',
  Blue: '#007aff',
  Purple: '#af52de',
  Gray: '#8e8e93',
};

const PANEL_IDS = {
  general: 'properties-panel-general',
  signatures: 'properties-panel-signatures',
  details: 'properties-panel-details',
  security: 'properties-panel-security',
} as const;

// macOS signs these bundles as directories, so they get a signature lookup like files do.
const SIGNABLE_BUNDLE_EXTENSIONS = new Set(['app', 'framework', 'bundle', 'appex', 'kext']);

const SIGNATURE_COPY_LABELS = { serialNumber: 'Serial number', thumbprint: 'Thumbprint' } as const;

type SignatureStatusView = { icon: string; tone: 'ok' | 'warn' | 'error'; text: string };

const PERM_ACTIONS = ['Read', 'Write', 'Execute'] as const;

// Permission bits for each row of the 3x3 grid, in Read / Write / Execute order.
const PERM_ROWS: ReadonlyArray<{ who: string; bits: readonly number[] }> = [
  { who: 'Owner', bits: [0o400, 0o200, 0o100] },
  { who: 'Group', bits: [0o040, 0o020, 0o010] },
  { who: 'Others', bits: [0o004, 0o002, 0o001] },
];

const SEPARATOR = '<div class="property-separator"></div>';

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 bytes';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(2);
  return `${bytes.toLocaleString()} bytes (${size} ${units[i]})`;
}

function formatPermissions(mode: number): string {
  const rwx = (m: number) => (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
  const owner = rwx((mode >> 6) & 7);
  const group = rwx((mode >> 3) & 7);
  const other = rwx(mode & 7);
  return `${owner}${group}${other}`;
}

function formatLongDate(value: Date): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}

// Accepts 1 to 4 octal digits in the 0..0o777 range. Returns null otherwise.
function parseOctal(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null;
  const value = parseInt(trimmed, 8);
  return value <= 0o777 ? value : null;
}

// valueHtml must already be escaped, or be trusted markup built by this file.
function propertyRow(label: string, valueHtml: string, valueClass = ''): string {
  const cls = valueClass ? `property-value ${valueClass}` : 'property-value';
  return `
    <div class="property-row">
      <div class="property-label">${escapeHtml(label)}</div>
      <div class="${cls}">${valueHtml}</div>
    </div>`;
}

function identityHtml(name: string | undefined, id: string | undefined): string {
  if (name && id) {
    return `${escapeHtml(name)} <span class="property-muted">(${escapeHtml(id)})</span>`;
  }
  const value = name || id;
  return value ? escapeHtml(value) : '';
}

function canHaveSignature(props: ItemProperties): boolean {
  if (!props.isDirectory) return true;
  const dot = props.name.lastIndexOf('.');
  return dot > 0 && SIGNABLE_BUNDLE_EXTENSIONS.has(props.name.slice(dot + 1).toLowerCase());
}

// Explorer shows the Digital Signatures tab only for signed files.
function isSignatureShown(info: CodeSignatureInfo | null): info is CodeSignatureInfo {
  return info !== null && info.supported && info.signed;
}

function signatureStatusView(status: CodeSignatureInfo['status']): SignatureStatusView {
  switch (status) {
    case 'valid':
      return { icon: 'check-circle', tone: 'ok', text: 'This digital signature is OK.' };
    case 'untrusted':
      return {
        icon: 'alert-triangle',
        tone: 'warn',
        text: 'This digital signature is not trusted.',
      };
    case 'expired':
      return { icon: 'alert-triangle', tone: 'warn', text: 'This digital signature has expired.' };
    case 'revoked':
      return {
        icon: 'x-circle',
        tone: 'error',
        text: 'This digital signature has been revoked.',
      };
    case 'invalid':
      return { icon: 'x-circle', tone: 'error', text: 'This digital signature is not valid.' };
    default:
      return {
        icon: 'alert-triangle',
        tone: 'warn',
        text: 'This digital signature could not be verified.',
      };
  }
}

function notAvailableHtml(): string {
  return '<span class="property-muted">Not available</span>';
}

// Backend strings are escaped here, so every signature value is safe to interpolate.
function signatureTextHtml(value: string | undefined): string {
  return value ? escapeHtml(value) : notAvailableHtml();
}

function signatureDateHtml(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return notAvailableHtml();
  return escapeHtml(formatLongDate(new Date(value)));
}

function signerCopyValueHtml(
  value: string | undefined,
  field: keyof typeof SIGNATURE_COPY_LABELS
): string {
  if (!value) return notAvailableHtml();
  const label = SIGNATURE_COPY_LABELS[field];
  return `<div class="property-path-row"><span class="property-path">${escapeHtml(value)}</span><button type="button" class="property-btn-copy" data-action="copy-signer-field" data-field="${field}" aria-label="Copy ${escapeHtml(label)}" title="Copy ${escapeHtml(label)}">${twemojiImg('clipboard', 'twemoji')}</button></div>`;
}

function signerDetailsHtml(signer: CodeSigner): string {
  return [
    propertyRow('Signer:', signatureTextHtml(signer.name)),
    propertyRow('Issuer:', signatureTextHtml(signer.issuer)),
    propertyRow('Serial number:', signerCopyValueHtml(signer.serialNumber, 'serialNumber')),
    propertyRow('Thumbprint:', signerCopyValueHtml(signer.thumbprint, 'thumbprint')),
    propertyRow('Valid from:', signatureDateHtml(signer.validFrom)),
    propertyRow('Valid to:', signatureDateHtml(signer.validTo)),
  ].join('');
}

// The table uses a shorter date so each signer fits on one line. The details block keeps the long form.
function signatureTableDateHtml(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return notAvailableHtml();
  const text = new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return escapeHtml(text);
}

function signerRowHtml(signer: CodeSigner, index: number, selected: boolean): string {
  return `
        <tr role="row" data-role="signer-row" data-index="${index}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">
          <td class="signature-col-name" title="${escapeHtml(signer.name ?? '')}">${signatureTextHtml(signer.name)}</td>
          <td class="signature-col-digest">${signatureTextHtml(signer.digestAlgorithm)}</td>
          <td class="signature-col-time">${signatureTableDateHtml(signer.timestamp)}</td>
        </tr>`;
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

  const showPropertiesDialog = (initialProps: ItemProperties): void => {
    clearActive();

    const modal = document.getElementById('properties-modal');
    const content = document.getElementById('properties-content');
    const closeBtn = document.getElementById('properties-close');
    const okBtn = document.getElementById('properties-ok') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('properties-cancel');
    const applyBtn = document.getElementById('properties-apply') as HTMLButtonElement | null;
    const tablist = modal?.querySelector<HTMLElement>('[role="tablist"]');

    if (!modal || !content || !okBtn || !applyBtn || !tablist) return;

    const tabEls = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

    let props = initialProps;
    let sessionClosed = false;
    let applying = false;

    // attrs holds the checkbox values. attrBase holds the last values known to be on disk.
    const attrs = { readOnly: false, hidden: false };
    const attrBase = { readOnly: false, hidden: false };
    let modeBase: number | null = null;
    let modeBits = 0;
    let modeText = '';

    let folderSizeTotal: number | null = null;
    let folderStatus = 'Not calculated';
    let folderRun: OperationRun | null = null;
    let folderRunning = false;
    let folderProgress = '';

    let checksumRun: OperationRun | null = null;
    let checksumRunning = false;
    let checksumPercent = 0;
    let checksumProgress = '';
    const checksumValues: Partial<Record<ChecksumAlgorithm, string>> = {};

    // Cached for this dialog session, so Apply re-renders without asking the backend again.
    let signature: CodeSignatureInfo | null = null;
    let selectedSignerIndex = 0;
    const signatureTab = tabEls.find((tab) => tab.dataset.tab === 'signatures') ?? null;

    const syncAttrs = (source: ItemProperties) => {
      attrBase.readOnly = source.isReadOnly === true;
      attrBase.hidden = source.isHiddenAttr === true;
      attrs.readOnly = attrBase.readOnly;
      attrs.hidden = attrBase.hidden;
    };

    const syncMode = (source: ItemProperties) => {
      modeBase = source.mode === undefined ? null : source.mode & 0o777;
      modeBits = modeBase ?? 0;
      modeText = modeBase === null ? '' : modeBase.toString(8);
    };

    const attrDirty = () =>
      attrs.readOnly !== attrBase.readOnly || attrs.hidden !== attrBase.hidden;

    const modeDirty = () => {
      if (modeBase === null) return false;
      const parsed = parseOctal(modeText);
      return parsed === null || parsed !== modeBase;
    };

    const isDirty = () => attrDirty() || modeDirty();

    const syncFooter = () => {
      applyBtn.disabled = applying || !isDirty();
      okBtn.disabled = applying;
    };

    const find = <T extends HTMLElement = HTMLElement>(role: string): T | null =>
      content.querySelector<T>(`[data-role="${role}"]`);

    const contentsHtml = (): string => {
      const button = folderRunning
        ? `<button type="button" class="property-btn property-btn-cancel" data-action="cancel-folder-size" aria-label="Cancel folder size calculation">${twemojiImg('x', 'twemoji')} Cancel</button>`
        : `<button type="button" class="property-btn" data-action="calc-folder-size" aria-label="Calculate folder size">${twemojiImg('bar-chart-3', 'twemoji')} Calculate Size</button>`;
      const progress = folderRunning
        ? `<div class="property-progress-container"><div class="property-progress-bar indeterminate" data-role="folder-bar"></div></div>
        <div class="property-progress-text" data-role="folder-progress">${escapeHtml(folderProgress || 'Calculating...')}</div>`
        : '';
      return `<div class="property-inline"><span data-role="folder-info">${escapeHtml(folderStatus)}</span>${button}</div>${progress}`;
    };

    const buildGeneral = (): string => {
      const isDir = props.isDirectory;
      const groups: string[] = [];

      const typeName = isDir ? 'Folder' : deps.getFileTypeFromName(props.name);
      const ext = props.extension ? props.extension.replace(/^\./, '') : '';
      const typeRows = [
        propertyRow(
          'Type of file:',
          `${escapeHtml(typeName)}${ext ? ` (.${escapeHtml(ext)})` : ''}`
        ),
      ];
      if (props.opensWith) {
        typeRows.push(propertyRow('Opens with:', escapeHtml(props.opensWith)));
      }
      typeRows.push(
        propertyRow('Location:', escapeHtml(rendererPath.dirname(props.path)), 'property-path')
      );
      if (props.symlinkTarget) {
        typeRows.push(
          propertyRow('Link target:', escapeHtml(props.symlinkTarget), 'property-path')
        );
      }
      if (props.shortcutTarget) {
        typeRows.push(propertyRow('Target:', escapeHtml(props.shortcutTarget), 'property-path'));
      }
      groups.push(typeRows.join(''));

      const sizeRows = [
        propertyRow('Size:', escapeHtml(formatSize(folderSizeTotal ?? props.size))),
      ];
      if (props.sizeOnDisk !== undefined) {
        sizeRows.push(propertyRow('Size on disk:', escapeHtml(formatSize(props.sizeOnDisk))));
      }
      if (isDir) {
        sizeRows.push(propertyRow('Contents:', contentsHtml(), 'property-folder-size'));
      }
      groups.push(sizeRows.join(''));

      groups.push(
        [
          propertyRow('Created:', escapeHtml(formatLongDate(props.created))),
          propertyRow('Modified:', escapeHtml(formatLongDate(props.modified))),
          propertyRow('Accessed:', escapeHtml(formatLongDate(props.accessed))),
        ].join('')
      );

      const attrBoxes: string[] = [];
      if (props.isReadOnly !== undefined) {
        attrBoxes.push(
          `<label><input type="checkbox" data-attr="readOnly"${attrs.readOnly ? ' checked' : ''}> Read-only</label>`
        );
      }
      if (props.isHiddenAttr !== undefined) {
        attrBoxes.push(
          `<label><input type="checkbox" data-attr="hidden"${attrs.hidden ? ' checked' : ''}> Hidden</label>`
        );
      }
      if (props.isSystemAttr) {
        attrBoxes.push('<span class="property-system-badge">System</span>');
      }
      if (attrBoxes.length > 0) {
        groups.push(
          propertyRow('Attributes:', `<div class="property-attrs-edit">${attrBoxes.join('')}</div>`)
        );
      }

      return `
    <div class="properties-header">
      <div class="properties-icon" data-role="icon" aria-hidden="true"></div>
      <div class="properties-name">${escapeHtml(props.name || props.path)}</div>
    </div>
    ${groups.join(SEPARATOR)}`;
    };

    const buildChecksums = (): string => {
      const action = checksumRunning
        ? `<div class="property-progress-container"><div class="property-progress-bar" data-role="checksum-bar"></div></div>
        <div class="property-progress-text" data-role="checksum-progress">${escapeHtml(checksumProgress || 'Calculating...')}</div>
        <button type="button" class="property-btn property-btn-cancel" data-action="cancel-checksum" aria-label="Cancel checksum calculation">${twemojiImg('x', 'twemoji')} Cancel</button>`
        : `<button type="button" class="property-btn" data-action="calc-checksum" aria-label="Calculate checksums">${twemojiImg('key', 'twemoji')} Calculate Checksums</button>`;
      const rows = CHECKSUM_ALGORITHMS.map((algo) => {
        const value = checksumValues[algo];
        const label = CHECKSUM_LABELS[algo];
        return `
    <div class="property-row property-checksum-row"${value ? '' : ' hidden'}>
      <div class="property-label">${escapeHtml(label)}:</div>
      <div class="property-value property-checksum">
        <code>${escapeHtml(value ?? '')}</code>
        <button type="button" class="property-btn-copy" data-action="copy-checksum" data-algo="${algo}" aria-label="Copy ${escapeHtml(label)} checksum" title="Copy ${escapeHtml(label)}">${twemojiImg('clipboard', 'twemoji')}</button>
      </div>
    </div>`;
      }).join('');
      return `${SEPARATOR}
    <div class="property-row">
      <div class="property-label">Checksums:</div>
      <div class="property-value property-checksum-actions">${action}</div>
    </div>${rows}`;
    };

    const buildDetails = (): string => {
      const groups: string[] = [
        propertyRow(
          'Full path:',
          `<div class="property-path-row"><span class="property-path">${escapeHtml(props.path)}</span><button type="button" class="property-btn-copy" data-action="copy-path" aria-label="Copy full path" title="Copy full path">${twemojiImg('clipboard', 'twemoji')}</button></div>`
        ),
      ];
      if (props.extension) {
        groups.push(
          propertyRow('Extension:', escapeHtml(`.${props.extension.replace(/^\./, '')}`))
        );
      }
      if (props.mimeType) {
        groups.push(propertyRow('MIME type:', escapeHtml(props.mimeType)));
      }
      if (props.isSymlink) {
        groups.push(propertyRow('Symbolic link:', 'Yes'));
      }
      if (props.isShortcut) {
        groups.push(propertyRow('Shortcut:', 'Yes'));
      }
      if (props.macTags && props.macTags.length > 0) {
        const tagHtml = props.macTags
          .map((tag) => {
            const colorName = tag.replace(/\n\d+$/, '');
            const color = TAG_COLORS[colorName];
            const dot = color
              ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle;"></span>`
              : '';
            return `<span class="property-tag">${dot}${escapeHtml(colorName)}</span>`;
          })
          .join(' ');
        groups.push(propertyRow('Tags:', tagHtml));
      }
      if (props.isFile) {
        groups.push(buildChecksums());
      }
      return groups.join('');
    };

    const permissionsHtml = (): string => {
      const head = PERM_ACTIONS.map(
        (action) => `<span class="property-perm-head">${action}</span>`
      ).join('');
      const cells = PERM_ROWS.map((row) => {
        const boxes = row.bits
          .map(
            (bit, i) =>
              `<input type="checkbox" data-perm-bit="${bit}" aria-label="${row.who} ${PERM_ACTIONS[i]}"${(modeBits & bit) !== 0 ? ' checked' : ''}>`
          )
          .join('');
        return `<span class="property-perm-who">${row.who}</span>${boxes}`;
      }).join('');
      const invalid = parseOctal(modeText) === null;
      return (
        propertyRow(
          'Permissions:',
          `<div class="property-perm-grid" role="group" aria-label="Permissions">
        <span></span>${head}${cells}
      </div>`
        ) +
        propertyRow(
          'Octal:',
          `<div class="property-perms-edit"><input type="text" class="property-perm-input" data-role="perm-octal" aria-label="Octal permissions" value="${escapeHtml(modeText)}" maxlength="4" size="5" aria-invalid="${invalid ? 'true' : 'false'}"> <code data-role="perm-rwx">${escapeHtml(formatPermissions(modeBits))}</code></div>`
        )
      );
    };

    const buildSecurity = (): string => {
      const groups: string[] = [];
      const ownerHtml = identityHtml(props.ownerName, props.owner);
      if (ownerHtml) groups.push(propertyRow('Owner:', ownerHtml));
      const groupHtml = identityHtml(props.groupName, props.group);
      if (groupHtml) groups.push(propertyRow('Group:', groupHtml));

      if (props.mode !== undefined) {
        groups.push(SEPARATOR, permissionsHtml());
      } else {
        const winAttrs: [string, boolean | undefined][] = [
          ['Archive', props.isArchiveAttr],
          ['Compressed', props.isCompressedAttr],
          ['Encrypted', props.isEncryptedAttr],
          ['Indexed', props.isIndexedAttr],
          ['System', props.isSystemAttr],
        ];
        const attrRows: string[] = [];
        for (const [label, value] of winAttrs) {
          if (value !== undefined) attrRows.push(propertyRow(`${label}:`, value ? 'Yes' : 'No'));
        }
        if (attrRows.length > 0) groups.push(SEPARATOR, ...attrRows);
        groups.push('<p class="property-note">Access control lists are managed by Windows.</p>');
      }
      return groups.join('');
    };

    const buildSignatures = (): string => {
      if (!isSignatureShown(signature)) return '';
      const info = signature;
      const view = signatureStatusView(info.status);
      const messageHtml = info.statusMessage
        ? `<div class="signature-status-message">${escapeHtml(info.statusMessage)}</div>`
        : '';
      const statusHtml = `<div class="signature-status" data-tone="${view.tone}" role="status">${twemojiImg(view.icon, 'signature-status-icon')}<div class="signature-status-body"><div class="signature-status-text">${escapeHtml(view.text)}</div>${messageHtml}</div></div>`;

      const signers = info.signers;
      selectedSignerIndex = Math.min(selectedSignerIndex, Math.max(signers.length - 1, 0));
      const selected = signers[selectedSignerIndex];
      const listHtml = selected
        ? `<div class="signature-table-wrap"><table class="signature-table" role="grid" aria-label="Signers"><colgroup><col class="signature-col-name"><col class="signature-col-digest"><col class="signature-col-time"></colgroup><thead><tr role="row"><th scope="col">Name of signer</th><th scope="col">Digest algorithm</th><th scope="col">Timestamp</th></tr></thead><tbody>${signers.map((signer, index) => signerRowHtml(signer, index, index === selectedSignerIndex)).join('')}</tbody></table></div><div class="signature-details" data-role="signer-details">${signerDetailsHtml(selected)}</div>`
        : '<p class="property-note">No signer details are available.</p>';

      const macRows: string[] = [];
      if (info.identifier) macRows.push(propertyRow('Identifier:', escapeHtml(info.identifier)));
      if (info.teamId) macRows.push(propertyRow('Team ID:', escapeHtml(info.teamId)));
      if (info.hardenedRuntime !== undefined) {
        macRows.push(propertyRow('Hardened Runtime:', info.hardenedRuntime ? 'Yes' : 'No'));
      }
      if (info.gatekeeperAccepted !== undefined) {
        macRows.push(propertyRow('Gatekeeper:', info.gatekeeperAccepted ? 'Accepted' : 'Rejected'));
      }
      const macHtml = macRows.length > 0 ? `${SEPARATOR}${macRows.join('')}` : '';

      return `${statusHtml}${listHtml}${macHtml}`;
    };

    const paintProgress = () => {
      const folderBar = find<HTMLElement>('folder-bar');
      if (folderBar) folderBar.style.width = '100%';
      const folderText = find('folder-progress');
      if (folderText) folderText.textContent = folderProgress || 'Calculating...';
      const checksumBar = find<HTMLElement>('checksum-bar');
      if (checksumBar) checksumBar.style.width = `${checksumPercent}%`;
      const checksumText = find('checksum-progress');
      if (checksumText) checksumText.textContent = checksumProgress || 'Calculating...';
    };

    const fillIcon = () => {
      const host = find('icon');
      if (!host) return;
      const cached = props.isDirectory ? undefined : deps.getThumbnailForPath(props.path);
      if (cached) {
        const img = document.createElement('img');
        img.src = cached;
        img.alt = '';
        host.replaceChildren(img);
        return;
      }
      host.innerHTML = props.isDirectory
        ? twemojiImg('folder', 'twemoji')
        : deps.getFileIcon(props.name);
    };

    const setPanel = (tab: keyof typeof PANEL_IDS, html: string) => {
      const panel = document.getElementById(PANEL_IDS[tab]);
      if (panel) panel.innerHTML = html;
    };

    const renderPanels = () => {
      setPanel('general', buildGeneral());
      setPanel('signatures', buildSignatures());
      setPanel('details', buildDetails());
      setPanel('security', buildSecurity());
      fillIcon();
      paintProgress();
      syncFooter();
    };

    const selectTab = (tabId: string, focus: boolean) => {
      for (const tab of tabEls) {
        const selected = tab.dataset.tab === tabId;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
        if (panel) panel.hidden = !selected;
        if (selected && focus) tab.focus();
      }
    };

    const copyText = (text: string, label: string) => {
      window.tauriAPI.writeToSystemClipboard(text).catch(ignoreError);
      deps.showToast(`${label} copied to clipboard`, 'Copied', 'success');
    };

    // Shows or hides the Digital Signatures tab. Leaves the tab if it is hidden while selected.
    const syncSignatureTab = () => {
      if (!signatureTab) return;
      const shown = isSignatureShown(signature);
      signatureTab.hidden = !shown;
      if (!shown && signatureTab.getAttribute('aria-selected') === 'true') {
        selectTab('general', false);
      }
    };

    // Updates the row selection and the details block in place, so focus stays on the row.
    const selectSigner = (index: number, focus: boolean) => {
      const count = signature?.signers.length ?? 0;
      if (index < 0 || index >= count) return;
      selectedSignerIndex = index;
      content.querySelectorAll<HTMLElement>('[data-role="signer-row"]').forEach((row) => {
        const selected = Number(row.dataset.index) === selectedSignerIndex;
        row.setAttribute('aria-selected', String(selected));
        row.tabIndex = selected ? 0 : -1;
        if (selected && focus) row.focus();
      });
      const signer = signature?.signers[selectedSignerIndex];
      const details = find('signer-details');
      if (details && signer) details.innerHTML = signerDetailsHtml(signer);
    };

    // The lookup runs after the dialog renders, so a slow backend never delays it.
    const requestSignature = async () => {
      if (!canHaveSignature(initialProps)) return;
      let info: CodeSignatureInfo | null = null;
      try {
        const result = await window.tauriAPI.getCodeSignature(initialProps.path);
        if (result.success) info = result.signature;
      } catch {
        // A failed lookup leaves the tab hidden, the same as an unsigned file.
      }
      // A result for a closed dialog, or for an earlier item, must not reveal the tab.
      if (sessionClosed) return;
      signature = info;
      syncSignatureTab();
      setPanel('signatures', buildSignatures());
    };

    const stopFolderSize = (cancelBackend: boolean) => {
      const run = folderRun;
      if (!run) return;
      folderRun = null;
      folderRunning = false;
      if (cancelBackend) {
        window.tauriAPI.cancelFolderSizeCalculation(run.id).catch(ignoreError);
      }
      run.unlisten();
    };

    const startFolderSize = async () => {
      if (folderRun) return;
      const id = createOperationId('foldersize');
      const unlisten = window.tauriAPI.onFolderSizeProgress((progress) => {
        if (progress.operationId !== id) return;
        folderProgress = `${progress.fileCount} files, ${progress.folderCount} folders - ${formatSize(progress.calculatedSize)}`;
        paintProgress();
      });
      const run: OperationRun = { id, unlisten };
      folderRun = run;
      folderRunning = true;
      folderProgress = '';
      renderPanels();

      try {
        const result = await window.tauriAPI.calculateFolderSize(props.path, id);
        if (folderRun !== run) return;
        if (!result.success) {
          if (result.error !== 'Calculation cancelled') {
            folderStatus = `Error: ${result.error || 'Operation failed'}`;
          }
        } else {
          const { totalSize, fileCount, folderCount } = result.result;
          folderSizeTotal = totalSize;
          folderStatus = `${fileCount} files, ${folderCount} folders (${formatSize(totalSize)})`;
        }
      } catch (error) {
        if (folderRun !== run) return;
        folderStatus = `Error: ${getErrorMessage(error)}`;
      }

      folderRun = null;
      folderRunning = false;
      run.unlisten();
      renderPanels();
    };

    const cancelFolderSize = () => {
      stopFolderSize(true);
      folderStatus = 'Calculation cancelled';
      renderPanels();
    };

    const stopChecksum = (cancelBackend: boolean) => {
      const run = checksumRun;
      if (!run) return;
      checksumRun = null;
      checksumRunning = false;
      if (cancelBackend) {
        window.tauriAPI.cancelChecksumCalculation(run.id).catch(ignoreError);
      }
      run.unlisten();
    };

    const startChecksum = async () => {
      if (checksumRun) return;
      const id = createOperationId('checksum');
      const unlisten = window.tauriAPI.onChecksumProgress((progress) => {
        if (progress.operationId !== id) return;
        checksumPercent = progress.percent;
        checksumProgress = `Calculating ${progress.algorithm.toUpperCase()}... ${progress.percent.toFixed(1)}%`;
        paintProgress();
      });
      const run: OperationRun = { id, unlisten };
      checksumRun = run;
      checksumRunning = true;
      checksumPercent = 0;
      checksumProgress = '';
      renderPanels();

      try {
        const result = await window.tauriAPI.calculateChecksum(props.path, id, [
          ...CHECKSUM_ALGORITHMS,
        ]);
        if (checksumRun !== run) return;
        if (!result.success) {
          if (result.error !== 'Calculation cancelled') {
            deps.showToast(result.error || 'Checksum calculation failed', 'Error', 'error');
          }
        } else {
          for (const algo of CHECKSUM_ALGORITHMS) {
            const value = result.result[algo];
            if (value) checksumValues[algo] = value;
          }
        }
      } catch (error) {
        if (checksumRun !== run) return;
        deps.showToast(getErrorMessage(error), 'Error', 'error');
      }

      checksumRun = null;
      checksumRunning = false;
      run.unlisten();
      renderPanels();
    };

    const cancelChecksum = () => {
      stopChecksum(true);
      renderPanels();
    };

    const cleanup = () => {
      sessionClosed = true;
      stopFolderSize(true);
      stopChecksum(true);
      activeCleanup = null;
    };

    activeCleanup = cleanup;

    const closeModal = () => {
      if (sessionClosed) return;
      cleanup();
      modal.style.display = 'none';
      deps.onModalClose(modal);
    };

    // Applies every pending change. A failed step stays dirty, and the toast explains why.
    const applyPending = async (): Promise<boolean> => {
      applying = true;
      syncFooter();
      try {
        if (attrDirty()) {
          const payload: { readOnly?: boolean; hidden?: boolean } = {};
          if (props.isReadOnly !== undefined) payload.readOnly = attrs.readOnly;
          if (props.isHiddenAttr !== undefined) payload.hidden = attrs.hidden;
          const result = await window.tauriAPI.setAttributes(props.path, payload);
          if (!result.success) {
            deps.showToast(result.error || 'Failed to update attributes', 'Error', 'error');
            return false;
          }
          attrBase.readOnly = attrs.readOnly;
          attrBase.hidden = attrs.hidden;
          deps.showToast('Attributes updated', 'Success', 'success');
        }
        if (modeDirty()) {
          const octal = parseOctal(modeText);
          if (octal === null) {
            deps.showToast('Invalid permissions (use octal, e.g. 755)', 'Error', 'error');
            return false;
          }
          const result = await window.tauriAPI.setPermissions(props.path, octal);
          if (!result.success) {
            deps.showToast(result.error || 'Failed to update permissions', 'Error', 'error');
            return false;
          }
          modeBase = octal;
          modeBits = octal;
          modeText = octal.toString(8);
          deps.showToast('Permissions updated', 'Success', 'success');
        }
        return true;
      } catch (error) {
        deps.showToast(getErrorMessage(error), 'Error', 'error');
        return false;
      } finally {
        applying = false;
        syncFooter();
      }
    };

    const refreshProperties = async () => {
      try {
        const result = await window.tauriAPI.getItemProperties(props.path);
        if (sessionClosed) return;
        if (result.success) {
          props = result.properties;
          if (!attrDirty()) syncAttrs(props);
          if (!modeDirty()) syncMode(props);
        } else {
          deps.showToast(result.error || 'Failed to refresh properties', 'Error', 'error');
        }
      } catch (error) {
        deps.showToast(getErrorMessage(error), 'Error', 'error');
      }
      renderPanels();
    };

    const onApply = async () => {
      if (applying || !isDirty()) return;
      const ok = await applyPending();
      if (!ok || sessionClosed) return;
      await refreshProperties();
    };

    const onOk = async () => {
      if (applying) return;
      if (isDirty()) {
        const ok = await applyPending();
        if (!ok) return;
      }
      closeModal();
    };

    syncAttrs(props);
    syncMode(props);
    renderPanels();
    // A previous session may have left the tab revealed in the shared static markup.
    syncSignatureTab();
    selectTab('general', false);

    modal.style.display = 'flex';
    deps.onModalOpen(modal);

    if (closeBtn) closeBtn.onclick = closeModal;
    if (cancelBtn) cancelBtn.onclick = closeModal;
    okBtn.onclick = onOk;
    applyBtn.onclick = onApply;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };

    for (const tab of tabEls) {
      // Focus follows the click, as it does for arrow keys. Safari does not focus buttons on click.
      tab.onclick = () => selectTab(tab.dataset.tab ?? 'general', true);
    }
    tablist.onkeydown = (event: KeyboardEvent) => {
      // Hidden tabs (Digital Signatures on unsigned items) are skipped by the arrow keys.
      const shownTabs = tabEls.filter((tab) => !tab.hidden);
      const index = shownTabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      let next: number;
      switch (event.key) {
        case 'ArrowRight':
          next = (index + 1) % shownTabs.length;
          break;
        case 'ArrowLeft':
          next = (index - 1 + shownTabs.length) % shownTabs.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = shownTabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextTab = shownTabs[next];
      if (nextTab) selectTab(nextTab.dataset.tab ?? 'general', true);
    };

    content.onkeydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.dataset.role !== 'signer-row') return;
      let step: number;
      switch (event.key) {
        case 'ArrowDown':
          step = 1;
          break;
        case 'ArrowUp':
          step = -1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectSigner(selectedSignerIndex + step, true);
    };

    content.onclick = (event) => {
      const element = event.target as Element | null;
      const row = element?.closest<HTMLElement>('[data-role="signer-row"]');
      if (row) {
        selectSigner(Number(row.dataset.index), true);
        return;
      }
      const target = element?.closest<HTMLElement>('[data-action]');
      if (!target) return;
      switch (target.dataset.action) {
        case 'copy-path':
          copyText(props.path, 'Full path');
          break;
        case 'calc-folder-size':
          void startFolderSize();
          break;
        case 'cancel-folder-size':
          cancelFolderSize();
          break;
        case 'calc-checksum':
          void startChecksum();
          break;
        case 'cancel-checksum':
          cancelChecksum();
          break;
        case 'copy-checksum': {
          const algo = target.dataset.algo as ChecksumAlgorithm | undefined;
          const value = algo ? checksumValues[algo] : undefined;
          if (algo && value) copyText(value, CHECKSUM_LABELS[algo]);
          break;
        }
        case 'copy-signer-field': {
          const field = target.dataset.field;
          if (field !== 'serialNumber' && field !== 'thumbprint') break;
          const value = signature?.signers[selectedSignerIndex]?.[field];
          if (value) copyText(value, SIGNATURE_COPY_LABELS[field]);
          break;
        }
        default:
          break;
      }
    };

    content.onchange = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.attr === 'readOnly') {
        attrs.readOnly = target.checked;
      } else if (target.dataset.attr === 'hidden') {
        attrs.hidden = target.checked;
      } else if (target.dataset.permBit) {
        const bit = Number(target.dataset.permBit);
        modeBits = target.checked ? modeBits | bit : modeBits & ~bit;
        modeText = modeBits.toString(8);
        const octalInput = find<HTMLInputElement>('perm-octal');
        if (octalInput) {
          octalInput.value = modeText;
          octalInput.setAttribute('aria-invalid', 'false');
        }
        const rwx = find('perm-rwx');
        if (rwx) rwx.textContent = formatPermissions(modeBits);
      } else {
        return;
      }
      syncFooter();
    };

    content.oninput = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.dataset.role !== 'perm-octal') return;
      modeText = target.value;
      const parsed = parseOctal(modeText);
      if (parsed !== null) {
        modeBits = parsed;
        content.querySelectorAll<HTMLInputElement>('input[data-perm-bit]').forEach((box) => {
          box.checked = (modeBits & Number(box.dataset.permBit)) !== 0;
        });
        const rwx = find('perm-rwx');
        if (rwx) rwx.textContent = formatPermissions(modeBits);
      }
      target.setAttribute('aria-invalid', String(parsed === null));
      syncFooter();
    };

    void requestSignature();
  };

  return {
    showPropertiesDialog,
    cleanup: clearActive,
  };
}
