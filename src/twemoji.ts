function emojiToCodepoint(emoji: string): string {
  const codePoints: number[] = [];
  let i = 0;
  
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) {
      if (code !== 0xFE0F) {
        codePoints.push(code);
      }
      i += code > 0xFFFF ? 2 : 1;
    } else {
      i++;
    }
  }

  return codePoints.map(cp => cp.toString(16)).join('-');
}
export function emojiToTwemoji(emoji: string): string {
  const codepoint = emojiToCodepoint(emoji);
  return `assets/twemoji/${codepoint}.svg`;
}

export function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  const src = emojiToTwemoji(emoji);
  const altText = alt || emoji;
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" />`;
}

export function parseTwemoji(text: string, className: string = 'twemoji'): string {
  const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu;
  
  return text.replace(emojiRegex, (match) => {
    return twemojiImg(match, className);
  });
}

export const TWEMOJI = {
  home: '🏠',
  folder: '📂',
  folderOpen: '📁',
  location: '📍',
  search: '🔍',
  
  close: '✕',
  settings: '⚙️',
  refresh: '🔄',
  delete: '🗑️',
  cut: '✂️',
  copy: '📄',
  clipboard: '📋',
  rename: '✍️',
  star: '⭐',
  
  empty: '📭',
  eye: '👁️',
  terminal: '🖥️',
  info: 'ℹ️',
  heart: '❤️',
  warning: '⚠️',
  error: '❌',
  success: '✅',
  question: '❓',
  
  document: '📄',
  text: '📝',
  script: '📜',
  web: '🌐',
  palette: '🎨',
  image: '🖼️',
  video: '🎬',
  music: '🎵',
  archive: '🗜️',
  code: '💾',
  diskDrive: '💾',
  spreadsheet: '📊',

  python: '🐍',
  java: '☕',
  c: '©️',
  php: '🐘',
  ruby: '💎',
  golang: '🐹',
  rust: '🦀',

  picture: '🖼️',
  video2: '📹',
  audio: '🎵',

  file: '🗃️',
  paste: '📜',
  add: '➕',
};

export function getTwemoji(key: keyof typeof TWEMOJI, className: string = 'twemoji'): string {
  return twemojiImg(TWEMOJI[key], className);
}
