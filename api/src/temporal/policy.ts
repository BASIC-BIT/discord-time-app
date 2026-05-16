import type { Weekday, WeekdayQualifier } from "./types";

export const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export interface WeekdayPolicyRule {
  qualifier: WeekdayQualifier;
  description: string;
}

export const WEEKDAY_POLICY: readonly WeekdayPolicyRule[] = [
  {
    qualifier: "bare",
    description: "Resolve to the nearest upcoming occurrence in the user's timezone.",
  },
  {
    qualifier: "this",
    description: "Resolve inside the current week frame in the user's timezone.",
  },
  {
    qualifier: "next",
    description: "Resolve inside the following week frame, not tomorrow when tomorrow is that weekday.",
  },
  {
    qualifier: "last",
    description: "Resolve inside the previous week frame in the user's timezone.",
  },
];

export function describeWeekdayPolicy(qualifier: WeekdayQualifier): string {
  const rule = WEEKDAY_POLICY.find((entry) => entry.qualifier === qualifier);
  return rule?.description ?? "Unknown weekday policy qualifier.";
}
