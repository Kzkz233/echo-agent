/** Open only the authentication provider, never a URL supplied in model output. */
export async function openCodexLogin(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    !['auth.openai.com', 'chatgpt.com'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw Error('Invalid Codex authentication URL');
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_auth_url', { url });
  } else window.open(url, '_blank', 'noopener,noreferrer');
}
