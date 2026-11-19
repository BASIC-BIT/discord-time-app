// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Overlay } from './Overlay';
import { TimeParserAPIError } from '../lib/api-client';
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
const fake = vi.hoisted(() => ({ parse: vi.fn(), hosted: vi.fn(), eligible: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ auto_load_clipboard: false })) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'test', setFocus: vi.fn() }), LogicalSize: class {}, PhysicalPosition: class {}, currentMonitor: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({ sendNotification: vi.fn() }));
vi.mock('../lib/stats', () => ({ initStats: vi.fn(), getFormatStats: vi.fn(async () => []), getMostUsedFormatIndex: () => 0, incrementFormatUsage: vi.fn() }));
vi.mock('../lib/hosted-parser', () => ({ canUseHostedFallback: () => fake.eligible, parseHostedTime: fake.hosted }));
vi.mock('./HostedAccount', () => ({ HostedAccount: () => null }));
vi.mock('../lib/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api-client')>(),
  createAPIClient: async () => ({ parseTime: fake.parse, getPlanIrEndpointStatus: async () => ({ warmupEnabled: true, state: 'warming' }) }),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); fake.eligible = true;
  vi.mocked(invoke).mockResolvedValue({ auto_load_clipboard: false });
  vi.mocked(readText).mockResolvedValue('');
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
  expect(fake.hosted).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(700));
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

it('keeps the local error visible when hosted fallback is unavailable', async () => {
  fake.eligible = false;
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '5pms');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(fake.hosted).not.toHaveBeenCalled();
  expect(container.querySelector('.status-line')?.textContent).toContain('cold endpoint');
});

it('discards superseded input before starting cloud work', async () => {
  fake.hosted.mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  const type = async (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await type('5pms'); await act(async () => vi.advanceTimersByTimeAsync(350));
  await type('6pms'); await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(fake.hosted).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(fake.hosted).toHaveBeenCalledOnce(); expect(fake.hosted.mock.calls[0][0]).toBe('6pms');
});

it('preserves the local diagnosis and offers a usable retry after throttling', async () => {
  fake.hosted.mockRejectedValueOnce(new TimeParserAPIError('Wait a few seconds.', 429, 'rate_limited'))
    .mockResolvedValue({ epoch: 1795125600, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } });
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '5pms');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(container.querySelector('.status-line')?.textContent).toContain('cold endpoint');
  expect(container.querySelector('.status-line')?.textContent).toContain('Wait a few seconds');
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try smart parsing again')!;
  expect(retry).toBeDefined(); await act(async () => retry.click());
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledTimes(2); expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
  expect(container.querySelector('.status-line')).toBeNull();
});

it('does not read the clipboard when its saved preference cannot be loaded', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('settings unavailable'));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  expect(readText).not.toHaveBeenCalled();
});
it('requires an explicit action before sending auto-loaded clipboard text to the relay', async () => {
  vi.mocked(invoke).mockResolvedValue({ auto_load_clipboard: true });
  vi.mocked(readText).mockResolvedValue('Synthetic clipboard prose');
  fake.hosted.mockResolvedValue({ epoch: 1795125600, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } });
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(fake.parse).toHaveBeenCalled();
  expect(fake.hosted).not.toHaveBeenCalled();
  expect(container.querySelector('.status-line')?.textContent).toContain('clipboard text in the cloud');
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Parse clipboard with smart parsing')!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
});

it('accepts finished input after a prefix call starts and ignores its late result', async () => {
  let finishPrefix!: (value: unknown) => void;
  fake.hosted.mockImplementationOnce(() => new Promise(resolve => { finishPrefix = resolve; }))
    .mockResolvedValue({ epoch: 1795129200, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } });
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  const type = async (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await type('5pms'); await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledOnce();
  await type('6pms'); await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('1795129200');
  await act(async () => finishPrefix({ epoch: 1795125600, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } }));
  expect(container.textContent).toContain('1795129200'); expect(container.textContent).not.toContain('1795125600');
});
