import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  invoke: vi.fn(), open: vi.fn(),
  window: { label: 'main', setAlwaysOnTop: vi.fn(), setFocus: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: fake.open }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => fake.window }));

import { cancelHostedSignIn, getHostedAuthStatus, openHostedSignInBrowser, restoreHostedSignInWindow, type HostedAuthStatus } from './hosted-auth';

const pending: HostedAuthStatus = {
  configured: true, phase: 'pending', userCode: 'ABCD-EFGH',
  verificationUri: 'https://accounts.example/device', verificationUriComplete: null,
  expiresIn: 600, error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.window.label = 'main';
  fake.window.setAlwaysOnTop.mockResolvedValue(undefined);
  fake.window.setFocus.mockResolvedValue(undefined);
  fake.open.mockResolvedValue(undefined);
});

it('restores and focuses the original overlay after approval without reopening it', async () => {
  await openHostedSignInBrowser(pending);
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  fake.invoke.mockResolvedValue(pending);
  await getHostedAuthStatus();
  expect(fake.window.setAlwaysOnTop).toHaveBeenCalledTimes(1);
  fake.invoke.mockResolvedValue({ ...pending, phase: 'signed_in' });
  await getHostedAuthStatus();
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  expect(fake.window.setFocus).toHaveBeenCalledOnce();
  await getHostedAuthStatus();
  expect(fake.window.setFocus).toHaveBeenCalledOnce();
});

it('restores the overlay when cancelled or when the browser fails to open', async () => {
  await openHostedSignInBrowser(pending);
  fake.invoke.mockResolvedValue({ ...pending, phase: 'signed_out' });
  await cancelHostedSignIn();
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  expect(fake.window.setFocus).not.toHaveBeenCalled();
  fake.open.mockRejectedValue(new Error('browser unavailable'));
  await expect(openHostedSignInBrowser(pending)).rejects.toThrow('browser unavailable');
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
});

it('preserves settings window behavior', async () => {
  fake.window.label = 'settings';
  await openHostedSignInBrowser(pending);
  fake.invoke.mockResolvedValue({ ...pending, phase: 'signed_in' });
  await getHostedAuthStatus();
  expect(fake.window.setAlwaysOnTop).not.toHaveBeenCalled();
  expect(fake.window.setFocus).not.toHaveBeenCalled();
});
it('restores an abandoned pending overlay without stealing focus on later approval', async () => {
  await openHostedSignInBrowser(pending);
  await restoreHostedSignInWindow();
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  fake.invoke.mockResolvedValue({ ...pending, phase: 'signed_in' });
  await getHostedAuthStatus();
  expect(fake.window.setFocus).not.toHaveBeenCalled();
});
it('remembers cleanup while lowering the native window is still pending', async () => {
  let lowered!: () => void;
  fake.window.setAlwaysOnTop.mockImplementationOnce(() => new Promise<void>(resolve => { lowered = resolve; }));
  const opened = openHostedSignInBrowser(pending);
  await restoreHostedSignInWindow();
  lowered(); await opened;
  fake.invoke.mockResolvedValue({ ...pending, phase: 'signed_in' });
  await getHostedAuthStatus();
  expect(fake.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  expect(fake.window.setFocus).not.toHaveBeenCalled();
});
