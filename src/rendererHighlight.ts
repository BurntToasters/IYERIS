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
    const settle = (value: HighlightJs | null, clearLoading = false): void => {
      if (settled) return;
      settled = true;
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

    const existingScript = document.querySelector(
      'script[data-highlightjs="core"]'
    ) as HTMLScriptElement | null;
    if (existingScript) {
      const existingGlobal = (window as Window & { hljs?: HighlightJs }).hljs;
      if (existingGlobal) {
        hljs = existingGlobal;
        settle(hljs);
        return;
      }

      const onLoad = () => {
        const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
        hljs = globalHljs;
        settle(hljs);
      };
      const onError = () => {
        settle(null, true);
      };

      existingScript.addEventListener('load', onLoad, { once: true });
      existingScript.addEventListener('error', onError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '/vendor/highlight.js';
    script.dataset.highlightjs = 'core';
    script.onload = () => {
      const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
      hljs = globalHljs;
      settle(hljs);
    };
    script.onerror = () => {
      settle(null, true);
    };
    document.head.appendChild(script);
  });

  return hljsLoading;
}

export function getLanguageForExt(ext: string): string | null {
  return EXT_TO_LANG[ext.toLowerCase()] || null;
}
