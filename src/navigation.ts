export async function beforeNavigate() {
  const detail = { promises: [] as Promise<unknown>[] };
  window.dispatchEvent(new CustomEvent("foldory:before-navigate", { detail }));
  await Promise.all(detail.promises);
}
