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
    if (!await ctx.auth.getUserIdentity()) throw new ConvexError('Sign in to use hosted parsing.');
    if (!args.text.trim() || args.text.length > DISCORD_TIMESTAMP_MAX_INPUT_CHARS || !args.requestId || args.requestId.length > 128) {
      throw new ConvexError('Invalid temporal request.');
    }
    try { Temporal.Instant.from(args.now); }
    catch { throw new ConvexError('Invalid reference time.'); }
    try { new Intl.DateTimeFormat('en-US', { timeZone: args.tz }); }
    catch { throw new ConvexError('Invalid timezone.'); }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConvexError('Hosted parsing is not configured yet.');
    const started = Date.now();
    let result: TemporalParseResponse | undefined;
    try {
      result = await parseTemporalExpression({
        text: args.text, timeZone: args.tz, referenceInstant: args.now,
        requestId: args.requestId, openaiApiKey: apiKey,
        openaiModel: MODEL, openaiReasoningEffort: 'low',
        features: { planIr: true, deterministicPreflight: true, discordReferenceRouting: true },
        signal: AbortSignal.timeout(30_000),
      });
      // Keep model traces and raw prompts out of the client response.
      return { ...result, debug: {
        model: MODEL, reasoningEffort: 'low',
        finalValidation: result.debug?.finalValidation,
      } };
    } catch {
      throw new ConvexError('Hosted parsing is unavailable. Try again shortly.');
    } finally {
      await ctx.runMutation(internal.usage.record, {
        requestId: args.requestId, model: MODEL, status: result?.status ?? 'error',
        durationMs: Date.now() - started, inputLength: args.text.length,
        inputTokens: result?.debug?.inputTokens ?? 0, outputTokens: result?.debug?.outputTokens ?? 0,
      });
    }
  },
});
