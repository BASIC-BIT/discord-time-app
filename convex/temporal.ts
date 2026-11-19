'use node';

import { v, ConvexError } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { parseTemporalExpression } from '../api/src/temporal/index';
import { DISCORD_TIMESTAMP_MAX_INPUT_CHARS } from '@hammer-overlay/discord-timestamp-routing';
import type { TemporalParseResponse } from '../api/src/temporal/types';
import { Temporal } from '@js-temporal/polyfill';

const MODEL = 'gpt-6-luna';
export const parse = action({
  args: { text: v.string(), tz: v.string(), now: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<TemporalParseResponse> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: 'sign_in_required', message: 'Sign in to use hosted parsing.' });
    if (!args.text.trim() || args.text.length > DISCORD_TIMESTAMP_MAX_INPUT_CHARS || !args.requestId || args.requestId.length > 128) {
      throw new ConvexError('Invalid temporal request.');
    }
    try { Temporal.Instant.from(args.now); }
    catch { throw new ConvexError('Invalid reference time.'); }
    try { new Intl.DateTimeFormat('en-US', { timeZone: args.tz }); }
    catch { throw new ConvexError('Invalid timezone.'); }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConvexError('Hosted parsing is not configured yet.');
    await ctx.runMutation(internal.limits.admit, {});
    const started = Date.now();
    let result: TemporalParseResponse | undefined;
    let usageEvents = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageComplete = true;
    try {
      result = await parseTemporalExpression({
        text: args.text, timeZone: args.tz, referenceInstant: args.now,
        requestId: args.requestId, openaiApiKey: apiKey,
        openaiModel: MODEL, openaiReasoningEffort: 'low',
        features: { planIr: true, deterministicPreflight: true, discordReferenceRouting: true },
        signal: AbortSignal.timeout(30_000),
        deadlineMs: started + 30_000,
        onModelUsage(usage) {
          usageEvents += 1;
          if (usage === null) usageComplete = false;
          else { inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; }
        },
      });
      // Keep model traces and raw prompts out of the client response.
      const { clarificationQuestion, ...publicResult } = result;
      return { ...publicResult,
        ...(result.status === 'needs_clarification' && clarificationQuestion !== undefined ? {clarificationQuestion} : {}),
        ambiguity: result.validation.passed ? [] : ['Smart parsing could not verify this expression.'],
        validation: { ...result.validation, warnings: result.validation.passed ? [] : ['Smart parsing could not verify this expression.'] },
        debug: {
        model: MODEL, reasoningEffort: 'low',
      } };
    } catch (error) {
      // Log diagnostic metadata without raw prompts, provider messages, or credentials.
      console.error('Hosted parsing failed', { requestId: args.requestId, name: error instanceof Error ? error.name : 'UnknownError',
        status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null });
      throw new ConvexError('Hosted parsing is unavailable. Try again shortly.');
    } finally {
      try { await ctx.runMutation(internal.usage.record, {
        requestId: args.requestId, model: MODEL, status: result?.status ?? 'error',
        durationMs: Date.now() - started, inputLength: args.text.length,
        inputTokens: usageEvents ? inputTokens : result?.debug?.inputTokens ?? 0,
        outputTokens: usageEvents ? outputTokens : result?.debug?.outputTokens ?? 0,
        usageComplete: result !== undefined && usageComplete,
      }); } catch { console.warn('Could not record parsing usage', { requestId: args.requestId }); }
    }
  },
});
