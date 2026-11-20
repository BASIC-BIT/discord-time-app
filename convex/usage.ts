import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { SHARED_REQUESTS_PER_DAY } from './limits';

export const record = internalMutation({
  returns: v.null(),
  args: {
    usageComplete: v.optional(v.boolean()),
    requestId: v.string(), model: v.string(), status: v.string(),
    durationMs: v.number(), inputLength: v.number(),
    inputTokens: v.number(), outputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Sign in to use hosted parsing.');
    const existing = await ctx.db.query('users').withIndex('by_identity', q => q.eq('identity', identity.tokenIdentifier)).unique();
    const totals = {
      lastSeenAt: Date.now(),
      requests: (existing?.requests ?? 0) + 1,
      inputTokens: (existing?.inputTokens ?? 0) + args.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + args.outputTokens,
    };
    const userId = existing?._id ?? await ctx.db.insert('users', { identity: identity.tokenIdentifier, ...totals });
    if (existing) await ctx.db.patch(existing._id, totals);
    await ctx.db.insert('usage', { userId, ...args });
  },
});

export const mine = query({
  args: {},
  returns: v.union(v.null(), v.object({ requests: v.number(), inputTokens: v.number(), outputTokens: v.number() })),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db.query('users').withIndex('by_identity', q => q.eq('identity', identity.tokenIdentifier)).unique();
    return user ? { requests: user.requests, inputTokens: user.inputTokens, outputTokens: user.outputTokens } : { requests: 0, inputTokens: 0, outputTokens: 0 };
  },
});

export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldest = await ctx.db.query('usage').order('asc').take(2 * SHARED_REQUESTS_PER_DAY);
    for (const row of oldest) if (row._creationTime < cutoff) await ctx.db.delete(row._id);
    return null;
  },
});
