type HighlightJs = {
  highlightElement?: (element: Element) => void;
};

let hljs: HighlightJs | null = null;
let hljsLoading: Promise<HighlightJs | null> | null = null;

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  r: 'r',
  lua: 'lua',
  perl: 'perl',
  pl: 'perl',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',
};

export async function loadHighlightJs(): Promise<HighlightJs | null> {
  if (hljs) return hljs;
  if (hljsLoading) return hljsLoading;

  hljsLoading = new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let script: HTMLScriptElement | null = null;
    let onLoad: (() => void) | null = null;
    let onError: (() => void) | null = null;
    const settle = (value: HighlightJs | null, clearLoading = false): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (script && onLoad && onError) {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
      }
      if (clearLoading) {
        hljsLoading = null;
      }
      resolve(value);
    };

    const existingLink = document.querySelector('link[data-highlightjs="theme"]');
    if (!existingLink) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/highlight.css';
      link.dataset.highlightjs = 'theme';
      document.head.appendChild(link);
    }

    let existingScript = document.querySelector(
      'script[data-highlightjs="core"]'
    ) as HTMLScriptElement | null;
    if (existingScript && existingScript.dataset.highlightjsState === 'failed') {
      // A previous attempt may have left a terminal marker without an event
      // for this caller to observe. Remove it and start a fresh load instead
      // of waiting for the timeout on a script that can never fire again.
      existingScript.remove();
      existingScript = null;
    }
    if (existingScript) {
      const existingGlobal = (window as Window & { hljs?: HighlightJs }).hljs;
      if (existingGlobal) {
        hljs = existingGlobal;
        settle(hljs);
        return;
      }

      script = existingScript;
      onLoad = () => {
        script?.setAttribute('data-highlightjs-state', 'loaded');
        const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
        if (globalHljs) {
          hljs = globalHljs;
          settle(hljs);
        } else {
          script?.remove();
          settle(null, true);
        }
      };
      onError = () => {
        script?.setAttribute('data-highlightjs-state', 'failed');
        script?.remove();
        settle(null, true);
      };
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
    } else {
      script = document.createElement('script');
      script.src = '/vendor/highlight.js';
      script.dataset.highlightjs = 'core';
      script.dataset.highlightjsState = 'loading';
      onLoad = () => {
        script?.setAttribute('data-highlightjs-state', 'loaded');
        const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
        if (globalHljs) {
          hljs = globalHljs;
          settle(hljs);
        } else {
          script?.remove();
          settle(null, true);
        }
      };
      onError = () => {
        script?.setAttribute('data-highlightjs-state', 'failed');
        script?.remove();
        settle(null, true);
      };
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
    }

    // A script element inserted by another owner may already have fired its
    // terminal event before we observed it. Always bound the wait so a failed
    // vendor load cannot leave every future preview awaiting forever.
    timeout = setTimeout(() => {
      script?.setAttribute('data-highlightjs-state', 'failed');
      script?.remove();
      settle(null, true);
    }, 15_000);
    if (!existingScript && script) document.head.appendChild(script);
  });

  return hljsLoading;
}

export function getLanguageForExt(ext: string): string | null {
  return EXT_TO_LANG[ext.toLowerCase()] || null;
}
