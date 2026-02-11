const elementCache = new Map<string, HTMLElement>();

export function getById<T extends HTMLElement>(id: string): T | null {
  const cached = elementCache.get(id) as T | undefined;
  if (cached && document.contains(cached)) return cached;
  const element = document.getElementById(id) as T | null;
  if (element) {
    elementCache.set(id, element);
  } else {
    elementCache.delete(id);
  }
  return element;
}

export function setHtml(element: Element | null, html: string): void {
  if (element) {
    element.innerHTML = html;
  }
}

export function clearHtml(element: Element | null): void {
  if (element) {
    element.replaceChildren();
  }
}
