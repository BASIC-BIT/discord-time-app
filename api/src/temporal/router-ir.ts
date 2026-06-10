import * as z from 'zod';

export const TemporalRouterRouteSchema = z.enum([
  'deterministic_only',
  'local_plan',
  'clarify',
  'escalate_llm',
]);

export const TemporalRouterReasonCodeSchema = z.enum([
  'deterministic_passed',
  'local_plan_passed',
  'local_plan_failed',
  'local_plan_unstable',
  'clarification_required',
  'accepted_failure_status',
  'missing_local_eval',
  'wrong_singular_risk',
]);

export const TemporalRouterIrSchema = z.object({
  route: TemporalRouterRouteSchema,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(TemporalRouterReasonCodeSchema).min(1),
  reason: z.string(),
});

export type TemporalRouterRoute = z.infer<typeof TemporalRouterRouteSchema>;
export type TemporalRouterReasonCode = z.infer<typeof TemporalRouterReasonCodeSchema>;
export type TemporalRouterIr = z.infer<typeof TemporalRouterIrSchema>;
