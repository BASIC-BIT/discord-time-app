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
vi.mock('../lib/hosted-parser', () => ({ canUseHostedFallback: (error: unknown) => fake.eligible && !(error && typeof error === 'object' && 'code' in error && error.code === 'needs_clarification'), parseHostedTime: fake.hosted }));
vi.mock('./HostedAccount', () => ({ HostedAccount: () => <section aria-label="Account">Browser approval</section> }));
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

it('displays the validated Luna result after a ready RunPod plan rejects bare Easter', async () => {
  fake.parse.mockRejectedValue(new TimeParserAPIError('Rejected RunPod plan', 400, 'endpoint_plan_rejected'));
  fake.hosted.mockResolvedValue({
    epoch: 1806249600, method: 'agent+plan', confidence: 0.9,
    suggestedFormatIndex: 1, debug: { serverValidated: true },
  });
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'easter');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledOnce();
  expect(fake.hosted.mock.calls[0][0]).toBe('easter');
  expect(container.querySelector('.format-code')?.textContent).toContain('<t:1806249600:');
  expect(container.querySelector('.warming-notice')?.classList.contains('visible')).toBe(false);
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
it('lets the user clarify a timezone before parsing a timestamp', async () => {
  fake.eligible = false;
  fake.parse.mockRejectedValue(new TimeParserAPIError('Which timezone did you mean by CST?', 400, 'needs_clarification', [], undefined, false, false, true));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'tomorrow at 5pm CST');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  const choices = container.querySelector('[aria-label="Choose timezone"]')!;
  expect(choices.querySelectorAll('button')).toHaveLength(3);
  expect(container.querySelectorAll('.row')).toHaveLength(0);
  fake.parse.mockResolvedValue({ epoch: 1795125600, method: 'deterministic', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } });
  const central = [...choices.querySelectorAll('button')].find(button => button.textContent === 'US Central time')!;
  await act(async () => central.click());
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(input.value).toBe('tomorrow at 5pm America/Chicago');
  expect(fake.parse).toHaveBeenLastCalledWith(input.value, expect.anything(), expect.anything(), expect.anything());
  expect(fake.hosted).not.toHaveBeenCalled();
  expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
});
it('shows a relay clarification without prepending the local failure', async () => {
  fake.hosted.mockRejectedValue(new TimeParserAPIError('Did you mean AM or PM?', 400, 'needs_clarification', []));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '5pm cst a');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(container.querySelector('.clarification-title')?.textContent).toBe('Did you mean AM or PM?');
  expect(container.querySelector('[aria-label="Choose timezone"]')).toBeNull();
  expect(container.querySelector('.status-line')).toBeNull();
});
it('can use the model for a fuzzy clock after the user clarifies its timezone', async () => {
  fake.parse.mockRejectedValueOnce(new TimeParserAPIError('Which timezone did you mean by CST?', 400, 'needs_clarification', [], undefined, false, false, true))
    .mockRejectedValue(new Error('cold endpoint'));
  fake.hosted.mockResolvedValue({ epoch: 1795125600, method: 'agent+plan', confidence: 1, suggestedFormatIndex: 0, debug: { serverValidated: true } });
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'tmrw at seventeen hundred CST');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(fake.hosted).not.toHaveBeenCalled();
  const central = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose timezone"] button')].find(button => button.textContent === 'US Central time')!;
  await act(async () => central.click());
  await act(async () => vi.advanceTimersByTimeAsync(1100));
  expect(fake.hosted).toHaveBeenCalledOnce();
  expect(fake.hosted.mock.calls[0][0]).toBe('tmrw at seventeen hundred America/Chicago');
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

it('does not replace independent zones with one global timezone choice', async () => {
  fake.eligible = false;
  fake.parse.mockRejectedValue(new TimeParserAPIError('Which timezone should the timestamp use?', 400, 'needs_clarification', []));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '3pm EST to 5pm PST');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(container.querySelector('[aria-label="Choose timezone"]')).toBeNull();
});

it('honors the saved AI opt-out while local parsing remains available', async () => {
  vi.mocked(invoke).mockResolvedValue({auto_load_clipboard:false,use_llm_parsing:false});
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input=container.querySelector('textarea')!;
  const type=async(text:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await type('5pms'); await act(async()=>vi.advanceTimersByTimeAsync(1200));
  expect(fake.hosted).not.toHaveBeenCalled();
  fake.parse.mockResolvedValue({epoch:1795125600,method:'deterministic',confidence:1,suggestedFormatIndex:0,debug:{serverValidated:true}});
  await type('5pm'); await act(async()=>vi.advanceTimersByTimeAsync(400));
  expect(container.querySelectorAll('.row').length).toBeGreaterThan(0);
  expect(fake.hosted).not.toHaveBeenCalled();
});

it('does not send typed text to the cloud when saved settings cannot be read', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('settings unavailable'));
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input=container.querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'5pms');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>vi.advanceTimersByTimeAsync(1200));
  expect(fake.hosted).not.toHaveBeenCalled();
});

it('waits for the AI preference and then parses the latest typed text without clipboard overwrite', async () => {
  let finishSettings!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'get_settings' ? new Promise(resolve => {finishSettings=resolve;}) : Promise.resolve(undefined));
  fake.hosted.mockResolvedValue({epoch:1795125600,method:'agent+plan',confidence:1,suggestedFormatIndex:0,debug:{serverValidated:true}});
  await act(async () => root.render(<Overlay openToken={0} onClose={() => {}} />));
  const input=container.querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'5pms');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>vi.advanceTimersByTimeAsync(1200));
  expect(fake.hosted).not.toHaveBeenCalled();
  await act(async()=>finishSettings({auto_load_clipboard:true,use_llm_parsing:true}));
  await act(async()=>vi.advanceTimersByTimeAsync(1200));
  expect(input.value).toBe('5pms');
  expect(readText).not.toHaveBeenCalled();
  expect(fake.hosted).toHaveBeenCalledOnce();
  expect(fake.hosted.mock.calls[0][0]).toBe('5pms');
  expect(vi.mocked(invoke).mock.calls.filter(call=>call[0]==='get_settings')).toHaveLength(1);
});

it('keeps the browser sign-in panel mounted while another parse is in flight', async () => {
  fake.hosted.mockRejectedValue(new TimeParserAPIError('Sign in.',401,'sign_in_required'));
  await act(async()=>root.render(<Overlay openToken={0} onClose={()=>{}} />));
  const input=container.querySelector('textarea')!;
  const type=async(text:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await type('5pms'); await act(async()=>vi.advanceTimersByTimeAsync(1200));
  const account=container.querySelector('[aria-label="Account"]');
  expect(account).not.toBeNull();
  fake.parse.mockImplementation(()=>new Promise(()=>{}));
  await type('6pms'); await act(async()=>vi.advanceTimersByTimeAsync(400));
  expect(container.querySelector('[aria-label="Account"]')).toBe(account);
});

it.each([
  ['Smart parsing took too long.', 504, 'parse_timeout'],
  ['Smart parsing has reached its shared daily limit.', 429, 'shared_limit'],
] as const)('shows %s without offering an immediate retry', async (message, status, code) => {
  fake.hosted.mockRejectedValue(new TimeParserAPIError(message, status, code));
  await act(async()=>root.render(<Overlay openToken={0} onClose={()=>{}} />));
  const input=container.querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'5pms');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>vi.advanceTimersByTimeAsync(1200));
  expect(container.querySelector('.status-line')?.textContent).toContain(message);
  expect([...container.querySelectorAll('button')].some(button=>button.textContent==='Try smart parsing again')).toBe(false);
  expect(fake.hosted).toHaveBeenCalledOnce();
});
