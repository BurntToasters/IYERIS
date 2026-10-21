type MarkdownModule = {
  marked: {
    parse: (content: string, options?: { async?: boolean; breaks?: boolean }) => string;
  };
};

type PurifyAttributeData = {
  attrName?: string;
  attrValue?: string;
  keepAttr: boolean;
};

type Purifier = {
  addHook: (
    hook: 'uponSanitizeAttribute',
    callback: (node: Element, data: PurifyAttributeData) => void
  ) => void;
  sanitize: (
    html: string,
    options: { FORBID_TAGS: string[]; FORBID_ATTR: string[]; ALLOW_DATA_ATTR: boolean }
  ) => string;
};

const DANGEROUS_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'style',
  'link',
  'meta',
  'base',
  'noscript',
  'svg',
  'math',
  'template',
  'applet',
  'frame',
  'frameset',
  'portal',
  'audio',
  'video',
  'source',
  'track',
];

const DANGEROUS_ATTRS = new Set([
  'formaction',
  'background',
  'poster',
  'srcset',
  'imagesrcset',
  'ping',
  'sandbox',
  'allow',
  'allowfullscreen',
  'csp',
  'dirname',
  'http-equiv',
  'manifest',
  'xmlns',
  'contextmenu',
]);
const URL_ATTRS = new Set(['href', 'src', 'action', 'cite', 'longdesc', 'data', 'usemap']);
const SAFE_URL_PATTERN = /^(?:https?|mailto|#):/i;
const SAFE_RESOURCE_URL_PATTERN = /^(?:https?:\/\/asset\.localhost\/)/i;
const HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
// Keep malformed or adversarially expanded Markdown from monopolizing the
// renderer while DOMPurify parses it. Preview reads are much smaller, but the
// sanitizer is also an internal utility and must enforce its own bound.
export const MAX_MARKDOWN_HTML_LENGTH = 4 * 1024 * 1024;

let purifierHookInstalled = false;

export function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T | null> {
  let pending: Promise<T | null> | null = null;
  return () => {
    if (pending) return pending;
    const attempt = load().catch(() => {
      pending = null;
      return null;
    });
    pending = attempt;
    return attempt;
  };
}

export const loadMarked = createRetryableLoader(() =>
  import('marked').then((module) => module as MarkdownModule)
);

const loadPurifier = createRetryableLoader(() =>
  import('dompurify').then((module) => module.default as unknown as Purifier)
);

function installPurifierHook(purifier: Purifier): void {
  if (purifierHookInstalled) return;
  purifierHookInstalled = true;
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName?.toLowerCase();
    if (!name) return;
    if (name.startsWith('on') || name === 'style' || DANGEROUS_ATTRS.has(name)) {
      data.keepAttr = false;
      return;
    }
    if (name.includes(':') && (name.endsWith(':href') || name.endsWith(':src'))) {
      data.keepAttr = false;
      return;
    }
    if (!URL_ATTRS.has(name)) return;

    const value = (data.attrValue ?? '').trim();
    if (/^\s*(?:javascript|data|vbscript)\s*:/i.test(value)) {
      data.keepAttr = false;
    } else if (name === 'href') {
      if (value && !value.startsWith('#') && !SAFE_URL_PATTERN.test(value)) {
        data.keepAttr = false;
      }
    } else if (
      value &&
      (/^\s*\/\//.test(value) ||
        (HAS_SCHEME_PATTERN.test(value) && !SAFE_RESOURCE_URL_PATTERN.test(value)))
    ) {
      data.keepAttr = false;
    }
  });
}

export async function sanitizeMarkdownHtml(html: string): Promise<string> {
  if (typeof html !== 'string' || html.length > MAX_MARKDOWN_HTML_LENGTH) {
    throw new RangeError(`Markdown HTML exceeds ${MAX_MARKDOWN_HTML_LENGTH} characters`);
  }
  const purifier = await loadPurifier();
  if (!purifier) throw new Error('Markdown sanitizer unavailable');
  installPurifierHook(purifier);
  return purifier.sanitize(html, {
    FORBID_TAGS: DANGEROUS_TAGS,
    FORBID_ATTR: Array.from(DANGEROUS_ATTRS),
    ALLOW_DATA_ATTR: false,
  });
}
