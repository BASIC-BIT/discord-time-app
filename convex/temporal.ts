'use node';

import { v, ConvexError, type Infer } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { parseTemporalExpression } from '../api/src/temporal/index';
import { DISCORD_TIMESTAMP_MAX_INPUT_CHARS } from '@hammer-overlay/discord-timestamp-routing';
import type { TemporalParseResponse, TemporalRangeResult, TemporalRangeEndpoint, TemporalClarificationAlternative } from '../api/src/temporal/types';
import { Temporal } from '@js-temporal/polyfill';

const MODEL = 'gpt-6-luna';
const precision = v.union(v.literal('date'), v.literal('time'), v.literal('datetime'), v.literal('relative'));
const canonical = v.object({ isoInstant:v.string(), zonedDateTime:v.string(), timeZone:v.string(), precision, weekday:v.optional(v.string()) });
const endpoint = v.object({ epoch:v.number(), suggestedFormatIndex:v.number(), canonical });
const range = v.object({ start:endpoint, end:endpoint, discord:v.string() });
const kind = v.union(v.literal('instant'),v.literal('time_range'));
const alternative = v.object({ label:v.string(), kind:v.optional(kind), epoch:v.number(), suggestedFormatIndex:v.number(), range:v.optional(range), confidence:v.number(), method:v.string(), canonical, assumptions:v.array(v.string()) });
const publicResponse = v.object({
  status:v.union(v.literal('resolved'),v.literal('ambiguous'),v.literal('needs_clarification'),v.literal('failed')),
  kind:v.optional(kind), epoch:v.optional(v.number()), suggestedFormatIndex:v.optional(v.number()), range:v.optional(range),
  confidence:v.number(), method:v.string(), canonical:v.optional(canonical), assumptions:v.array(v.string()), ambiguity:v.array(v.string()),
  validation:v.object({passed:v.boolean(),checks:v.array(v.string()),warnings:v.array(v.string())}),
  clarificationQuestion:v.optional(v.string()), clarificationAlternatives:v.optional(v.array(alternative)),
  debug:v.object({model:v.string(),reasoningEffort:v.string(),ambiguousTimeZone:v.boolean()}),
});
function publicCanonical(value: NonNullable<TemporalParseResponse['canonical']>) {
  return {isoInstant:value.isoInstant,zonedDateTime:value.zonedDateTime,timeZone:value.timeZone,precision:value.precision,...(value.weekday===undefined?{}:{weekday:value.weekday})};
}
function publicEndpoint(value: TemporalRangeEndpoint) {
  return {epoch:value.epoch,suggestedFormatIndex:value.suggestedFormatIndex,canonical:publicCanonical(value.canonical)};
}
function publicRange(value: TemporalRangeResult) {
  return {start:publicEndpoint(value.start),end:publicEndpoint(value.end),discord:value.discord};
}
function publicAlternative(value: TemporalClarificationAlternative) {
  return {label:value.label,...(value.kind===undefined?{}:{kind:value.kind}),epoch:value.epoch,suggestedFormatIndex:value.suggestedFormatIndex,
    ...(value.range===undefined?{}:{range:publicRange(value.range)}),confidence:value.confidence,method:value.method,canonical:publicCanonical(value.canonical),assumptions:[]};
}

export const parse = action({
  args: { text: v.string(), tz: v.string(), now: v.string(), requestId: v.string() },
  returns: publicResponse,
  handler: async (ctx, args): Promise<Infer<typeof publicResponse>> => {
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
    const deadline = AbortSignal.timeout(30_000);
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
        features: { planIr: true, deterministicPreflight: false, discordReferenceRouting: true },
        signal: deadline,
        deadlineMs: started + 30_000,
        onModelUsage(usage) {
          usageEvents += 1;
          if (usage === null) usageComplete = false;
          else { inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; }
        },
      });
      deadline.throwIfAborted();
      // Parser additions are private until explicitly included here and in the return validator.
      return {status:result.status,confidence:result.confidence,method:result.method,assumptions:[],
        ...(result.status==='resolved'?{
          kind:result.kind??'instant',
          ...(result.epoch===undefined?{}:{epoch:result.epoch}),
          ...(result.suggestedFormatIndex===undefined?{}:{suggestedFormatIndex:result.suggestedFormatIndex}),
          ...(result.range===undefined?{}:{range:publicRange(result.range)}),
          ...(result.canonical===undefined?{}:{canonical:publicCanonical(result.canonical)}),
        }:{}),
        ...(result.status==='needs_clarification'?{
          ...(result.clarificationQuestion===undefined?{}:{clarificationQuestion:result.clarificationQuestion}),
          ...(result.clarificationAlternatives===undefined?{}:{clarificationAlternatives:result.clarificationAlternatives.map(publicAlternative)}),
        }:{}),
        ambiguity:result.validation.passed?[]:['Smart parsing could not verify this expression.'],
        validation:{passed:result.validation.passed,checks:[],warnings:result.validation.passed?[]:['Smart parsing could not verify this expression.']},
        debug:{model:MODEL,reasoningEffort:'low',ambiguousTimeZone:result.debug?.ambiguousTimeZone===true},
      };
    } catch (error) {
      // Log diagnostic metadata without raw prompts, provider messages, or credentials.
      console.error('Hosted parsing failed', { requestId: args.requestId, name: error instanceof Error ? error.name : 'UnknownError',
        status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null });
      if (deadline.aborted) throw new ConvexError({ code: 'parse_timeout', message: 'Smart parsing took too long. Try rewording the expression or choose the date and time.' });
      throw new ConvexError('Hosted parsing is unavailable. Try again shortly.');
    } finally {
      try { await ctx.runMutation(internal.usage.record, {
        requestId: args.requestId, model: MODEL, status: deadline.aborted ? 'timeout' : result?.status ?? 'error',
        durationMs: Date.now() - started, inputLength: args.text.length,
        inputTokens: usageEvents ? inputTokens : result?.debug?.inputTokens ?? 0,
        outputTokens: usageEvents ? outputTokens : result?.debug?.outputTokens ?? 0,
        usageComplete: result !== undefined && usageComplete,
      }); } catch { console.warn('Could not record parsing usage', { requestId: args.requestId }); }
    }
  },
});
