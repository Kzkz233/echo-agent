/** Reveal a real field, including its collapsed ancestors, after a page switch. */
export function revealSetting(label: string, root: ParentNode = document) {
  const find = () => {
    const scope = root.querySelector('.role-editor-content') ?? root.querySelector('main') ?? root;
    const match = [...scope.querySelectorAll<HTMLElement>('label > span, summary, legend, h2, h3, input[aria-label]')].find(node => (node.getAttribute('aria-label') || node.textContent)?.trim().includes(label));
    if (!match) return false;
    for (let el: HTMLElement | null = match; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true;
    const control = match.closest('label')?.querySelector<HTMLElement>('input, select, textarea');
    (control ?? match).scrollIntoView({ block: 'center' });
    control?.focus({ preventScroll: true });
    return true;
  };
  if (find()) return;
  const observer = new MutationObserver(() => { if (find()) observer.disconnect(); });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  window.setTimeout(() => observer.disconnect(), 2500);
}
