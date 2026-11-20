export async function loadClipboardText(enabled: boolean, read: () => Promise<string | null>): Promise<string> {
  if (!enabled) return '';
  try { return await read() ?? ''; }
  catch { return ''; }
}
