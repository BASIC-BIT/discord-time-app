import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { components } from './_generated/api';
import { RateLimiter, MINUTE, DAY } from '@convex-dev/rate-limiter';

export const SHARED_REQUESTS_PER_DAY = 100;

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  fallback: { kind: 'token bucket', rate: 10, period: MINUTE, capacity: 3 },
  fallbackDaily: { kind: 'token bucket', rate: SHARED_REQUESTS_PER_DAY, period: DAY, capacity: SHARED_REQUESTS_PER_DAY },
});

export const admit = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError('Sign in to use hosted parsing.');
    // Throwing rolls back all limiter debits, including component mutations.
    const limit = await rateLimiter.limit(ctx, 'fallback', { key: identity.tokenIdentifier });
    if (!limit.ok) throw new ConvexError({ code: 'rate_limited', message: 'Smart parsing is busy. Wait a few seconds, then try again.' });
    const daily = await rateLimiter.limit(ctx, 'fallbackDaily');
    if (!daily.ok) {
      console.warn('shared_daily_limit_reached');
      throw new ConvexError({ code: 'shared_limit', message: 'Smart parsing has reached its shared daily limit. Try again later.' });
    }
    return null;
  },
});
