import type { TemporalParseResponse } from './types';

type ExpectedRange = {
  startEpoch: number;
  endEpoch: number;
};

type DiagnosticExpectation =
  | { status: 'resolved'; epoch?: number; range?: ExpectedRange }
  | { status: 'needs_clarification'; alternativeEpochs?: number[]; alternativeRanges?: ExpectedRange[] }
  | { status: 'failed' };

type DiagnosticParsed = {
  status: TemporalParseResponse['status'];
  kind?: TemporalParseResponse['kind'];
  epoch?: number;
  range?: TemporalParseResponse['range'];
  clarificationAlternatives?: Array<{ epoch: number; range?: TemporalParseResponse['range'] }>;
};

export function unsafeTemporalDiagnosticMismatch(
  expected: DiagnosticExpectation,
  parsed: DiagnosticParsed,
): boolean {
  if (parsed.status === 'resolved' || parsed.epoch !== undefined || parsed.range !== undefined) {
    if (expected.status !== 'resolved') return true;
    if (expected.range !== undefined) {
      return parsed.kind !== 'time_range'
        || parsed.range === undefined
        || actualRangeKey(parsed.range) !== expectedRangeKey(expected.range);
    }
    return parsed.kind === 'time_range'
      || parsed.range !== undefined
      || parsed.epoch !== expected.epoch;
  }

  if (parsed.status !== 'needs_clarification') return false;
  const alternatives = parsed.clarificationAlternatives ?? [];
  if (alternatives.length === 0) return false;

  if (expected.status === 'failed') return true;
  if (expected.status === 'resolved') {
    if (expected.range !== undefined) {
      const expectedKey = expectedRangeKey(expected.range);
      return alternatives.some((alternative) =>
        alternative.range === undefined || actualRangeKey(alternative.range) !== expectedKey,
      );
    }
    return alternatives.some((alternative) => alternative.range !== undefined || alternative.epoch !== expected.epoch);
  }
  if (expected.alternativeRanges !== undefined) {
    const actual = alternatives
      .map((alternative) => alternative.range === undefined ? 'missing' : actualRangeKey(alternative.range))
      .sort();
    const wanted = expected.alternativeRanges.map(expectedRangeKey).sort();
    return JSON.stringify(actual) !== JSON.stringify(wanted);
  }
  if (expected.alternativeEpochs !== undefined) {
    if (alternatives.some((alternative) => alternative.range !== undefined)) return true;
    const actual = alternatives.map((alternative) => alternative.epoch).sort((left, right) => left - right);
    const wanted = [...expected.alternativeEpochs].sort((left, right) => left - right);
    return JSON.stringify(actual) !== JSON.stringify(wanted);
  }
  return false;
}

function actualRangeKey(range: NonNullable<TemporalParseResponse['range']>): string {
  return `${range.start.epoch}:${range.end.epoch}`;
}

function expectedRangeKey(range: ExpectedRange): string {
  return `${range.startEpoch}:${range.endEpoch}`;
}
