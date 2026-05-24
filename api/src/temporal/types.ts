export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type WeekdayQualifier = "bare" | "this" | "next" | "last";

export type TemporalPrecision = "date" | "time" | "datetime" | "relative";

export type TemporalMethod =
  | "deterministic"
  | "agent+tools"
  | "agent+tools+sandbox"
  | "agent+tools+web"
  | "fallback";

export type TemporalParseStatus = "resolved" | "ambiguous" | "needs_clarification" | "failed";

export interface CalendarContext {
  referenceInstant: string;
  timeZone: string;
  locale?: string;
  country?: string;
  subdivision?: string;
}

export interface Candidate {
  id: string;
  isoInstant: string;
  zonedDateTime: string;
  timeZone: string;
  precision: TemporalPrecision;
  assumptions: string[];
  provenance: "chrono" | "holiday_library" | "shift_math" | "sandbox" | "explicit";
}

export interface CandidateFacts {
  weekday: Weekday;
  isoDate: string;
  isoInstant: string;
  dayOfWeek: number;
  weekOfYear?: number;
  month: number;
  year: number;
  timeZone: string;
}

export interface TemporalAgentContext {
  reference: {
    instant: string;
    timeZone: string;
    localDate: string;
    localTime: string;
    localWeekday: Weekday;
  };
  chrono: TemporalChronoContext;
  holidays: TemporalHolidayHint[];
}

export interface TemporalChronoContext {
  status: "matched" | "no_match";
  matchedText?: string;
  index?: number;
  coverage?: {
    matchedChars: number;
    inputChars: number;
  };
  unparsedText?: string;
  candidate?: TemporalChronoCandidateContext;
}

export interface TemporalChronoCandidateContext {
  isoInstant: string;
  zonedDateTime: string;
  timeZone: string;
  precision: TemporalPrecision;
}

export interface TemporalHolidayHint {
  name: string;
  isoDate: string;
  country: string;
  source: "date-holidays";
}

export interface CandidateFormat {
  style: "short" | "full" | "weekday-check" | "discord-preview";
  formatted: string;
}

export interface EnrichedCandidate {
  candidate: Candidate;
  facts?: CandidateFacts;
  formats: CandidateFormat[];
  validation?: TemporalValidation;
  finalizable: boolean;
}

export interface CandidateProposal {
  isoInstant: string;
  timeZone: string;
  precision: TemporalPrecision;
  assumptions: string[];
  rationale: string;
}

export interface TemporalValidation {
  passed: boolean;
  warnings: string[];
  checks: string[];
}

export interface TemporalAgentTraceStep {
  index: number;
  type: "llm" | "tool" | "final_validation";
  name: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
}

export interface TemporalFinalValidation {
  accepted: boolean;
  confidence: number;
  reason: string;
  missingOrContradictedSignals: string[];
}

export interface TemporalParseRequest {
  text: string;
  calendarContext: CalendarContext;
}

export interface TemporalParseResponse {
  status: TemporalParseStatus;
  epoch?: number;
  suggestedFormatIndex?: number;
  confidence: number;
  method: TemporalMethod;
  canonical?: {
    isoInstant: string;
    zonedDateTime: string;
    timeZone: string;
    precision: TemporalPrecision;
    weekday?: Weekday;
  };
  assumptions: string[];
  ambiguity: string[];
  validation: TemporalValidation;
  clarificationQuestion?: string;
  clarificationAlternatives?: TemporalClarificationAlternative[];
  debug?: {
    chosenCandidateId?: string;
    candidateCount?: number;
    agentAttempts?: number;
    toolPasses?: number;
    deterministicDurationMs?: number;
    agentDurationMs?: number;
    totalDurationMs?: number;
    trace?: TemporalAgentTraceStep[];
    finalValidation?: TemporalFinalValidation;
    langfuseTraceId?: string;
  };
}

export interface TemporalClarificationAlternative {
  label: string;
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
  method: TemporalMethod;
  canonical: {
    isoInstant: string;
    zonedDateTime: string;
    timeZone: string;
    precision: TemporalPrecision;
    weekday?: Weekday;
  };
  assumptions: string[];
}

export type AgentToolName =
  | "parse_expression"
  | "resolve_calendar_query"
  | "resolve_holiday"
  | "resolve_clock_time"
  | "shift_datetime"
  | "set_clock_time"
  | "propose_candidate"
  | "finalize_candidate"
  | "ask_clarification"
  | "sandbox_eval"
  | "web_lookup";

export interface AgentToolRequest {
  tool: AgentToolName;
  input: unknown;
}

export interface AgentDecision {
  action: "call_tools" | "propose_candidate" | "finalize_candidate" | "ask_clarification" | "fail";
  rationale: string;
  toolRequests?: AgentToolRequest[];
  candidateProposal?: CandidateProposal;
  selectedCandidateId?: string;
  clarificationQuestion?: string;
}
