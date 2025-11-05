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

function emojiToImg(emoji: string, className: string = 'twemoji'): string {
  const codepoint = emojiToCodepoint(emoji);
  const src = `assets/twemoji/${codepoint}.svg`;
  return `<img src="${src}" class="${className}" alt="${emoji}" draggable="false" />`;
}

function parseTextNode(node: Text): void {
  const text = node.textContent || '';

  if (!text || text.length > 10000) return;

  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F1E0}-\u{1F1FF}][\u{FE0F}\u{200D}]?/gu;
  
  const matches: Array<{ emoji: string, index: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = emojiRegex.exec(text)) !== null) {
    matches.push({ emoji: match[0], index: match.index });
    if (match.index === emojiRegex.lastIndex) {
      emojiRegex.lastIndex++;
    }
  }

  if (matches.length === 0) return;
  
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const { emoji, index } of matches) {
    if (index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex, index)));
    }

    const span = document.createElement('span');
    span.innerHTML = emojiToImg(emoji);
    if (span.firstChild) {
      fragment.appendChild(span.firstChild);
    }
    
    lastIndex = index + emoji.length;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
  }
  
  node.parentNode?.replaceChild(fragment, node);
}

function replaceEmojis(element: Element): void {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  const nodes: Text[] = [];
  let node: Node | null;
  
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
  }
  
  nodes.forEach(parseTextNode);
}

export function initTwemoji(): void {
  replaceEmojis(document.body);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          replaceEmojis(node as Element);
        } else if (node.nodeType === Node.TEXT_NODE) {
          parseTextNode(node as Text);
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}
