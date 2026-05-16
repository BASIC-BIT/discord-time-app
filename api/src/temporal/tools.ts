import type { CalendarContext, Candidate, CandidateFacts, CandidateProposal } from "./types";
import {
  candidateFacts,
  formatCandidate,
  parseExpression,
  resolveCalendarQuery,
  shiftDateTime,
  validateCandidate,
} from "./deterministic";

export interface ParseExpressionInput {
  text: string;
  calendarContext: CalendarContext;
}

export interface ParseExpressionOutput {
  candidates: Candidate[];
  parserNotes: string[];
}

export interface ResolveCalendarQueryInput {
  query: string;
  calendarContext: CalendarContext;
}

export interface ResolveCalendarQueryOutput {
  candidates: Candidate[];
  source: "holiday_library" | "chrono" | "shift_math" | "sandbox" | "web" | "explicit";
  notes: string[];
}

export interface ShiftDateTimeInput {
  base: { isoInstant: string } | { plainDate: string; timeZone: string } | { zonedDateTime: string };
  delta: {
    years?: number;
    months?: number;
    weeks?: number;
    days?: number;
    hours?: number;
    minutes?: number;
  };
  calendarContext: CalendarContext;
}

export interface FormatCandidateInput {
  candidate: Candidate;
  style: "short" | "full" | "weekday-check" | "discord-preview";
  calendarContext: CalendarContext;
}

export interface CandidateFactsInput {
  candidate: Candidate;
  calendarContext: CalendarContext;
}

export interface ValidateCandidateInput {
  originalText: string;
  candidate: Candidate;
  calendarContext: CalendarContext;
}

export interface ValidateCandidateOutput {
  passed: boolean;
  warnings: string[];
  errors: string[];
  ambiguity: string[];
  suggestedFormatIndex: number;
}

export interface ProposeCandidateInput extends CandidateProposal {}

export interface FinalizeCandidateInput {
  candidateId: string;
  rationale: string;
}

export interface TemporalToolImplementations {
  parseExpression(input: ParseExpressionInput): Promise<ParseExpressionOutput>;
  resolveCalendarQuery(input: ResolveCalendarQueryInput): Promise<ResolveCalendarQueryOutput>;
  shiftDateTime(input: ShiftDateTimeInput): Promise<Candidate>;
  formatCandidate(input: FormatCandidateInput): Promise<string>;
  candidateFacts(input: CandidateFactsInput): Promise<CandidateFacts>;
  validateCandidate(input: ValidateCandidateInput): Promise<ValidateCandidateOutput>;
}

export const AGENT_FACING_TEMPORAL_TOOL_NAMES = [
  "parse_expression",
  "resolve_calendar_query",
  "shift_datetime",
  "propose_candidate",
  "finalize_candidate",
  "sandbox_eval",
  "web_lookup",
] as const;

export const INTERNAL_TEMPORAL_TOOL_NAMES = ["format_candidate", "candidate_facts", "validate_candidate"] as const;

export function createUnimplementedTemporalToolImplementations(): TemporalToolImplementations {
  return {
    async parseExpression(input) {
      void input;
      throw new Error("parseExpression is not implemented yet.");
    },
    async resolveCalendarQuery(input) {
      void input;
      throw new Error("resolveCalendarQuery is not implemented yet.");
    },
    async shiftDateTime(input) {
      void input;
      throw new Error("shiftDateTime is not implemented yet.");
    },
    async formatCandidate(input) {
      void input;
      throw new Error("formatCandidate is not implemented yet.");
    },
    async candidateFacts(input) {
      void input;
      throw new Error("candidateFacts is not implemented yet.");
    },
    async validateCandidate(input) {
      void input;
      throw new Error("validateCandidate is not implemented yet.");
    },
  };
}

export function createDeterministicTemporalToolImplementations(): TemporalToolImplementations {
  return {
    parseExpression,
    resolveCalendarQuery,
    shiftDateTime,
    formatCandidate,
    candidateFacts,
    validateCandidate,
  };
}
