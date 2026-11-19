import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { getHostedClerk } from './hosted-auth';
import { TimeParserAPIError, type ParseResponse } from './api-client';

export function canUseHostedFallback(error: unknown): boolean {
  return error instanceof TimeParserAPIError && error.endpointWarming && error.status === 400 && error.code !== 'needs_clarification';
}

export async function parseHostedTime(text: string, tz: string, now: string, requestId: string, signal: AbortSignal): Promise<ParseResponse | null> {
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const clerk = await getHostedClerk();
  // The main and Settings windows share native credentials, but Clerk JS state needs refreshing.
  await clerk?.client?.reload();
  const token = await clerk?.session?.getToken({ template: 'convex' });
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (!token) throw new TimeParserAPIError('Sign in to use smart parsing while the model warms up.', 401, 'sign_in_required');
  const client = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL);
  client.setAuth(token);
  // shortcut: Convex actions cannot be cancelled by the client; discard stale results and bound server work.
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let result;
  try { result = await Promise.race([client.action(api.temporal.parse, { text, tz, now, requestId }), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (result.status !== 'resolved' || result.epoch === undefined || !result.validation.passed) {
    throw new TimeParserAPIError(result.clarificationQuestion ?? 'Could not verify that time. Try adding a date or AM/PM.', 400,
      result.status === 'needs_clarification' ? 'needs_clarification' : 'parse_failed', result.clarificationAlternatives, requestId);
  }
  return {
    generationId: requestId, kind: result.kind ?? 'instant', epoch: result.epoch,
    suggestedFormatIndex: result.suggestedFormatIndex ?? 4, range: result.range,
    confidence: result.confidence, method: result.method, canonical: result.canonical,
    debug: { endpointWarming: true, serverValidated: true },
  };
}
