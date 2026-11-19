// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Overlay } from './Overlay';
const fake = vi.hoisted(() => ({ parse: vi.fn(), hosted: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ auto_load_clipboard: false })) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'test', setFocus: vi.fn() }), LogicalSize: class {}, PhysicalPosition: class {}, currentMonitor: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({ sendNotification: vi.fn() }));
vi.mock('../lib/stats', () => ({ initStats: vi.fn(), getFormatStats: vi.fn(async () => []), getMostUsedFormatIndex: () => 0, incrementFormatUsage: vi.fn() }));
vi.mock('../lib/hosted-parser', () => ({ canUseHostedFallback: () => true, parseHostedTime: fake.hosted }));
vi.mock('./HostedAccount', () => ({ HostedAccount: () => null }));
vi.mock('../lib/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api-client')>(),
  createAPIClient: async () => ({ parseTime: fake.parse, getPlanIrEndpointStatus: async () => ({ warmupEnabled: true, state: 'warming' }) }),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fake.parse.mockRejectedValue(new Error('cold endpoint'));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
it('shows fallback progress through a slow request and removes warmup messaging after success', async () => {
  let complete!: (value: unknown) => void;
  fake.hosted.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '5pms');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(fake.hosted).toHaveBeenCalledOnce();
  const status = container.querySelector('[role=status]');
  expect(status?.classList.contains('visible')).toBe(true);
  expect(status?.textContent).toContain('This may take a few seconds');
  expect(container.querySelector('.warming-notice')?.classList.contains('visible')).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(status?.textContent).toContain('Parsing with smart fallback');
  await act(async () => complete({ epoch: 1795125600, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } }));
  expect(container.querySelector('[role=status]')).toBeNull();
  expect(container.querySelector('.warming-notice')?.classList.contains('visible')).toBe(false);
  expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
});
