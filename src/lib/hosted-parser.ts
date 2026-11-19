import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { getHostedAuthToken, hostedConfigured } from './hosted-auth';
import { ConvexError } from 'convex/values';
import { TimeParserAPIError, type ParseResponse } from './api-client';

export function canUseHostedFallback(error: unknown): boolean {
  return hostedConfigured && error instanceof TimeParserAPIError && error.endpointWarming && !error.llmFallbackAttempted && error.status === 400 && error.code !== 'needs_clarification';
}

export async function parseHostedTime(text: string, tz: string, now: string, requestId: string, signal: AbortSignal): Promise<ParseResponse | null> {
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (!hostedConfigured) throw new TimeParserAPIError('Smart fallback is not configured in this build.', 503);
  const token = await getHostedAuthToken();
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
  catch (error) {
    if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
      const data = error.data as { code?: string; message?: string };
      if (data.code === 'sign_in_required') throw new TimeParserAPIError(data.message ?? 'Please sign in again.', 401, 'sign_in_required');
      if (data.code === 'rate_limited') throw new TimeParserAPIError(data.message ?? 'Please try again shortly.', 429, 'rate_limited');
    }
    throw error;
  }
  finally { signal.removeEventListener('abort', onAbort); }
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const hasResult = result.kind === 'time_range' ? result.range !== undefined : result.epoch !== undefined;
  if (result.status !== 'resolved' || !hasResult || !result.validation.passed) {
    throw new TimeParserAPIError(result.clarificationQuestion ?? 'Could not verify that time. Try adding a date or AM/PM.', 400,
      result.status === 'needs_clarification' ? 'needs_clarification' : 'parse_failed', result.clarificationAlternatives, requestId);
  }
  return {
    generationId: requestId, kind: result.kind ?? 'instant', epoch: result.epoch ?? result.range!.start.epoch,
    suggestedFormatIndex: result.suggestedFormatIndex ?? 4, range: result.range,
    confidence: result.confidence, method: result.method, canonical: result.canonical,
    debug: { endpointWarming: true, serverValidated: true },
  };
}
