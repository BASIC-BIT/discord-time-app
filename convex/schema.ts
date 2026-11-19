import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    identity: v.string(),
    lastSeenAt: v.number(),
    requests: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }).index('by_identity', ['identity']),
  usage: defineTable({
    userId: v.id('users'),
    usageComplete: v.optional(v.boolean()),
    requestId: v.string(),
    model: v.string(),
    status: v.string(),
    durationMs: v.number(),
    inputLength: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }).index('by_user', ['userId']),
});
