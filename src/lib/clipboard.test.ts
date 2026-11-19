import { expect, test, vi } from 'vitest';
import { loadClipboardText } from './clipboard';

test('disabled clipboard loading never reads clipboard contents', async () => {
  const read = vi.fn();
  expect(await loadClipboardText(false, read)).toBe('');
  expect(read).not.toHaveBeenCalled();
});

test('enabled clipboard loading handles text, empty, and unavailable clipboards', async () => {
  expect(await loadClipboardText(true, async () => '5pm')).toBe('5pm');
  expect(await loadClipboardText(true, async () => null)).toBe('');
  expect(await loadClipboardText(true, async () => { throw new Error('unavailable'); })).toBe('');
});
