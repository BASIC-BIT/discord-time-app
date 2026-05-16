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
  provenance: "weekday_policy" | "chrono" | "holiday_library" | "shift_math" | "sandbox" | "explicit";
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
  debug?: {
    chosenCandidateId?: string;
    candidateCount?: number;
    agentAttempts?: number;
    toolPasses?: number;
  };
}

export type AgentToolName =
  | "parse_expression"
  | "resolve_calendar_query"
  | "shift_datetime"
  | "propose_candidate"
  | "finalize_candidate"
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
