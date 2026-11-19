// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedAccount } from './HostedAccount';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
const fake = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), cancel: vi.fn(), open: vi.fn(), restore: vi.fn(async () => {}), changed: (() => {}) as () => void }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_: string, callback: () => void) => { fake.changed = callback; return () => {}; }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(async () => {}) }));
vi.mock('../lib/hosted-auth', () => ({ hostedConfigured: true, getHostedAuthStatus: fake.status, startHostedSignIn: fake.start, cancelHostedSignIn: fake.cancel, openHostedSignInBrowser: fake.open, restoreHostedSignInWindow: fake.restore, signOutHostedAuth: vi.fn() }));
const signedOut = { configured: true, phase: 'signed_out', error: null };
const pending = { ...signedOut, phase: 'pending', userCode: 'ABCD-EFGH', verificationUri: 'https://accounts.example/device' };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fake.status.mockResolvedValue(signedOut); fake.start.mockResolvedValue(pending); fake.cancel.mockResolvedValue(signedOut); fake.open.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(onSignedIn?: () => void) { await act(async () => root.render(<HostedAccount onSignedIn={onSignedIn} />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label));
  expect(button).toBeDefined(); await act(async () => button!.click());
}
it('opens the actual browser and displays the code with a cancel action', async () => {
  await render(); await click('Sign in with browser');
  expect(fake.open).toHaveBeenCalledWith(pending);
  expect(container.textContent).toContain('ABCD-EFGH'); expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('[role=status]')?.textContent).toContain('Waiting for browser approval');
  await click('Cancel'); expect(fake.cancel).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Sign in with browser');
});
it('ignores a late response after cancelling a sign-in request', async () => {
  let complete!: (value: typeof pending) => void;
  fake.start.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await render(); await click('Sign in with browser'); await click('Cancel');
  await act(async () => complete(pending)); expect(fake.open).not.toHaveBeenCalled();
});
it('shows expiry and allows another attempt', async () => {
  await render(); await click('Sign in with browser');
  fake.status.mockResolvedValue({ ...signedOut, error: 'This sign-in code expired. Please try again.' });
  await act(async () => fake.changed()); expect(container.querySelector('[role=alert]')?.textContent).toContain('expired');
  await click('Sign in with browser'); expect(fake.start).toHaveBeenCalledTimes(2);
});
it('automatically resumes once the browser approval completes', async () => {
  const resumed = vi.fn(); await render(resumed); await click('Sign in with browser');
  fake.status.mockResolvedValue({ ...signedOut, phase: 'signed_in' });
  await act(async () => fake.changed()); await act(async () => fake.changed());
  expect(resumed).toHaveBeenCalledOnce(); expect(container.textContent).toContain('You’re connected');
});
it('does not resume parsing merely because an already signed-in account panel mounts', async () => {
  fake.status.mockResolvedValue({ ...signedOut, phase: 'signed_in' });
  const resumed = vi.fn(); await render(resumed);
  await act(async () => fake.changed());
  expect(resumed).not.toHaveBeenCalled();
});
it('keeps the browser above the overlay if the pending panel is removed', async () => {
  await render(); await click('Sign in with browser');
  await act(async () => root.render(null));
  expect(fake.restore).not.toHaveBeenCalled();
});
it('keeps the code and browser retry available if opening the browser fails', async () => {
  fake.open.mockRejectedValue(new Error('unavailable')); await render(); await click('Sign in with browser');
  expect(container.textContent).toContain('ABCD-EFGH'); expect(container.querySelector('[role=alert]')?.textContent).toContain('Could not open');
  await click('Open browser'); expect(fake.open).toHaveBeenCalledTimes(2);
  expect(container.querySelector('details')?.open).toBe(true);
});
it('confirms code copying without losing the waiting state', async () => {
  await render(); await click('Sign in with browser'); await click('Copy code');
  expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
  expect(container.textContent).toContain('Copied');
  expect(container.querySelector('[role=status]')?.textContent).toContain('Waiting for browser approval');
});
