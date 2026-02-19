let markedInstance: typeof import('marked') | null = null;

export async function loadMarked(): Promise<typeof import('marked') | null> {
  if (markedInstance) return markedInstance;
  try {
    markedInstance = await import('marked');
    return markedInstance;
  } catch {
    return null;
  }
}
