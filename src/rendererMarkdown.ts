type MarkdownModule = {
  marked: {
    parse: (content: string, options?: { async?: boolean; breaks?: boolean }) => string;
  };
};

let markedInstance: MarkdownModule | null = null;

export async function loadMarked(): Promise<MarkdownModule | null> {
  if (markedInstance) return markedInstance;
  try {
    const specifier = 'marked';
    markedInstance = (await import(specifier)) as MarkdownModule;
    return markedInstance;
  } catch {
    return null;
  }
}
