const DISCORD_TIMESTAMP_CLASSIFIER_VERSION = "discord-reference-v2";
const DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS = 253402300799;
const DISCORD_TIMESTAMP_MAX_INPUT_CHARS = 16384;
const DISCORD_TIMESTAMP_MAX_MODEL_CHARS = 4096;

const FORMAT_CODES = [":d", ":D", ":t", ":T", ":f", ":F", ":R"];
const TIMESTAMP_SOURCE = String.raw`<t:(\d{1,12})(?::([tTdDfFR]))?>`;
const TIMESTAMP_GLOBAL = new RegExp(TIMESTAMP_SOURCE, "g");
const TIMESTAMP_LIKE = /[<＜]t[:：]/gi;
const ENCODED_TIMESTAMP_LIKE = /%3c\s*t\s*%3a/gi;
const EXACT_RANGE = new RegExp(
  String.raw`^\s*${TIMESTAMP_SOURCE}\s*(?:-|–|—|\bto\b)\s*${TIMESTAMP_SOURCE}\s*$`,
  "i",
);
const HARMLESS_WRAPPER = /^[\s`'"“”‘’()[\]{}*_~>|.\\-]*$/u;
const DISCORD_TIMESTAMP_AMOUNT_SOURCE = String.raw`(?:\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|fifty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|sixty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|seventy(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|eighty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|ninety(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const UNIT_SOURCE = String.raw`(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)`;
const CLOCK_SOURCE = String.raw`(?:(?:0?[1-9]|1[0-2])(?:[:.][0-5]\d)?(?:\s*(?:a(?:\.?m\.?)?|p(?:\.?m\.?)?))?|(?:[01]?\d|2[0-3])[:.][0-5]\d|midnight|noon)`;
const AFFIRMATIVE_TIMEZONE_SOURCE = String.raw`(?:(?:utc|gmt)(?:\s*[+-]\s*(?:0?\d|1\d|2[0-3])(?::?[0-5]\d)?)?|[ecmp][sd]t|bst|ist|jst|aest|aedt|pacific|mountain|central|eastern|tokyo|london|berlin|india|japan|australia|america\/[a-z_]+|europe\/[a-z_]+|asia\/[a-z_]+|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)(?![+\-:/\d])`;
const AFFIRMATIVE_CLOCK_CHANGE = new RegExp(
  String.raw`\bchange\s+(?:(?:the\s+)?time\s+of\s+)?${TIMESTAMP_SOURCE}\s+(?:to|at)\s+${CLOCK_SOURCE}(?=[\s,.!?;]*(?:(?:please|thanks?|now)\b[\s,.!?;]*)*$)`,
  "gi",
);
const AFFIRMATIVE_TIMEZONE_CLOCK_CHANGE = new RegExp(
  String.raw`\b(?:set|change|move|make|use|keep)\s+(?:(?:the\s+)?time\s+of\s+)?${TIMESTAMP_SOURCE}\s+(?:to|at)\s+${CLOCK_SOURCE}\s+${AFFIRMATIVE_TIMEZONE_SOURCE}`,
  "i",
);
const AFFIRMATIVE_TIMEZONE_REFERENCE_RELATIONSHIP = new RegExp(
  String.raw`(?:\b(?:starts?|begins?)\s+at\s+${TIMESTAMP_SOURCE}\s+and(?:\s+then)?\s+(?:ends?|finishes?)\s+at\s+${CLOCK_SOURCE}|${TIMESTAMP_SOURCE}\s*(?:to|through|until)\s*${CLOCK_SOURCE})\s+${AFFIRMATIVE_TIMEZONE_SOURCE}`,
  "i",
);
const AFFIRMATIVE_BETWEEN_REFERENCE_CLOCK = new RegExp(
  String.raw`\bbetween\s+(?:${TIMESTAMP_SOURCE}\s+and\s+${CLOCK_SOURCE}|${CLOCK_SOURCE}\s+and\s+${TIMESTAMP_SOURCE})(?![\w:])`,
  "i",
);
const NEGATION_OR_CORRECTION = /\b(?:don['’]?t|do\s+not|not|never|ignore|wrong|incorrect|correction|corrected|instead|changed?|cancel(?:led)?|old\s+time|outdated|mistake)\b/i;
const CONDITIONAL_OR_UNCERTAIN = /\b(?:if|unless|maybe|perhaps|possibly|probably|tentative|tbd|unknown|unsure|might|could|would)\b|\?/i;
const COMPARISON = /\b(?:compare|versus|vs\.?|difference|between|earlier\s+of|later\s+of|which\s+(?:is\s+)?(?:first|earlier|later))\b/i;
const SCHEDULING = /\b(?:schedule|reschedule|calendar|create\s+an?\s+event|book|remind\s+me|set\s+an?\s+alarm)\b/i;
const TIMEZONE = /\b(?:utc|gmt|[ecmp][sd]t|bst|ist|jst|aest|aedt|pacific|mountain|central|eastern|tokyo|london|berlin|india|japan|australia|america\/[a-z_]+|europe\/[a-z_]+|asia\/[a-z_]+)\b|[+-]\d{2}:\d{2}\b/i;
const DURATION = new RegExp(String.raw`\b${DISCORD_TIMESTAMP_AMOUNT_SOURCE}\s+${UNIT_SOURCE}\b`, "i");
const SUBDAY_DURATION = new RegExp(String.raw`\b${DISCORD_TIMESTAMP_AMOUNT_SOURCE}\s+(?:minutes?|mins?|hours?|hrs?)\b`, "i");
const OTHER_TEMPORAL_ENTITY = new RegExp(
  String.raw`\b(?:today|tomorrow|yesterday|tonight|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|last|later|earlier|before|after|from\s+now|ago|${UNIT_SOURCE}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{4}-\d{2}-\d{2}\b`,
  "i",
);
const PRESENTATION_ANCHOR = /\b(?:(?:the\s+)?(?:event|meeting|party|show|stream|class|session|launch|deadline|doors?)\s+(?:starts?|begins?|happens|is|will\s+be|opens?)|starts?|begins?|happens|scheduled)\s+(?:at|on|for)?\s*$/i;
const REFERENCE_RELATIONSHIP = /\b(?:to|through|until|from|after|before|later|earlier|starts?|ends?|move|shift|extend|shorten)\b|(?:^|\s)[-–—](?:\s|$)/i;

function discordTimestampFormatIndex(formatCode) {
  const normalized = formatCode === undefined || formatCode === "" ? ":f" : formatCode.startsWith(":") ? formatCode : `:${formatCode}`;
  const index = FORMAT_CODES.indexOf(normalized);
  return index >= 0 ? index : 4;
}

function discordTimestampFormatCode(formatIndex) {
  return FORMAT_CODES[formatIndex] ?? ":f";
}

function classifyDiscordTimestampInput(text, options = {}) {
  const maxInputChars = options.maxInputChars ?? DISCORD_TIMESTAMP_MAX_INPUT_CHARS;
  const maxModelChars = options.maxModelChars ?? DISCORD_TIMESTAMP_MAX_MODEL_CHARS;
  const inputLength = text.length;
  const base = {
    version: DISCORD_TIMESTAMP_CLASSIFIER_VERSION,
    references: [],
    malformedCount: 0,
    contextClass: "plain",
    signals: [],
    inputLength,
    inputLengthBucket: inputLengthBucket(inputLength),
    modelEligible: inputLength <= maxModelChars,
    meaningfulResidue: false,
  };

  if (inputLength > maxInputChars) {
    return { ...base, route: "reject", reason: "input_too_long" };
  }

  const references = extractReferences(text);
  const malformedCount = malformedTimestampCount(text, references);
  const contextClass = aggregateContext(references);
  const resultBase = { ...base, references, malformedCount, contextClass };

  if (malformedCount > 0) {
    return { ...resultBase, route: "reject", reason: "malformed_timestamp_syntax", meaningfulResidue: true };
  }
  if (references.length === 0) {
    return { ...resultBase, route: "no_reference", reason: "no_timestamp_reference" };
  }

  const signals = semanticSignals(text);
  const withSignals = { ...resultBase, signals };

  if (references.length === 2 && EXACT_RANGE.test(text)) {
    if (references[0].epochSeconds >= references[1].epochSeconds) {
      return { ...withSignals, route: "clarify", reason: "invalid_timestamp_range", meaningfulResidue: true };
    }
    return { ...withSignals, route: "direct_range", reason: "exact_timestamp_range" };
  }

  if (references.length > 1) {
    if (signals.includes("comparison")) {
      return { ...withSignals, route: "clarify", reason: "unsupported_comparison", meaningfulResidue: true };
    }
    if (signals.includes("scheduling")) {
      return { ...withSignals, route: "clarify", reason: "unsupported_scheduling", meaningfulResidue: true };
    }
    if (signals.includes("timezone") && !AFFIRMATIVE_TIMEZONE_CLOCK_CHANGE.test(text) && !AFFIRMATIVE_TIMEZONE_REFERENCE_RELATIONSHIP.test(text)) {
      return { ...withSignals, route: "clarify", reason: "unsupported_timezone_presentation", meaningfulResidue: true };
    }
    if (signals.includes("negation_or_correction")) {
      return { ...withSignals, route: "clarify", reason: "negated_or_corrected_reference", meaningfulResidue: true };
    }
    if (signals.includes("conditional_or_uncertain")) {
      return { ...withSignals, route: "clarify", reason: "conditional_or_uncertain_reference", meaningfulResidue: true };
    }
    if (contextClass === "url" || contextClass === "inline_code" || contextClass === "fenced_code" || contextClass === "quoted") {
      return { ...withSignals, route: "clarify", reason: "ambiguous_code_or_url_context", meaningfulResidue: true };
    }
    if (REFERENCE_RELATIONSHIP.test(text)) {
      if (inputLength > maxModelChars) {
        return { ...withSignals, route: "reject", reason: "model_input_too_long", meaningfulResidue: true };
      }
      return { ...withSignals, route: "model", reason: "semantic_residue_requires_model", meaningfulResidue: true };
    }
    return { ...withSignals, route: "clarify", reason: "multiple_timestamps_without_relationship", meaningfulResidue: true };
  }

  const reference = references[0];
  const residue = `${text.slice(0, reference.start)}${text.slice(reference.end)}`;
  if (HARMLESS_WRAPPER.test(residue) && contextClass !== "url") {
    const standalone = text.trim() === reference.raw;
    return {
      ...withSignals,
      route: "direct_instant",
      reason: standalone ? "standalone_timestamp" : "standalone_wrapped_timestamp",
    };
  }

  if (signals.includes("comparison") && !AFFIRMATIVE_BETWEEN_REFERENCE_CLOCK.test(text)) {
    return { ...withSignals, route: "clarify", reason: "unsupported_comparison", meaningfulResidue: true };
  }
  if (signals.includes("scheduling")) {
    return { ...withSignals, route: "clarify", reason: "unsupported_scheduling", meaningfulResidue: true };
  }
  if (signals.includes("timezone") && !AFFIRMATIVE_TIMEZONE_CLOCK_CHANGE.test(text) && !AFFIRMATIVE_TIMEZONE_REFERENCE_RELATIONSHIP.test(text)) {
    return { ...withSignals, route: "clarify", reason: "unsupported_timezone_presentation", meaningfulResidue: true };
  }
  if (signals.includes("negation_or_correction")) {
    return { ...withSignals, route: "clarify", reason: "negated_or_corrected_reference", meaningfulResidue: true };
  }
  if (signals.includes("conditional_or_uncertain")) {
    return { ...withSignals, route: "clarify", reason: "conditional_or_uncertain_reference", meaningfulResidue: true };
  }
  if (contextClass === "url" || contextClass === "inline_code" || contextClass === "fenced_code" || contextClass === "quoted") {
    return { ...withSignals, route: "clarify", reason: "ambiguous_code_or_url_context", meaningfulResidue: true };
  }

  if (isAffirmativePresentationProse(text, reference, residue)) {
    return { ...withSignals, route: "copied_prose", reason: "affirmative_presentation_prose", meaningfulResidue: true };
  }

  if (inputLength > maxModelChars) {
    return { ...withSignals, route: "reject", reason: "model_input_too_long", meaningfulResidue: true };
  }

  return { ...withSignals, route: "model", reason: "semantic_residue_requires_model", meaningfulResidue: true };
}

function extractReferences(text) {
  const references = [];
  TIMESTAMP_GLOBAL.lastIndex = 0;
  for (const match of text.matchAll(TIMESTAMP_GLOBAL)) {
    const raw = match[0];
    const epochText = match[1];
    const epoch = BigInt(epochText);
    if (epoch > BigInt(DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS)) {
      continue;
    }
    const start = match.index ?? 0;
    const formatCode = match[2] === undefined ? ":f" : `:${match[2]}`;
    references.push({
      raw,
      start,
      end: start + raw.length,
      epochSeconds: Number(epoch),
      formatCode,
      formatIndex: discordTimestampFormatIndex(formatCode),
      contextClass: contextAt(text, start, start + raw.length),
    });
  }
  return references;
}

function malformedTimestampCount(text, references) {
  const starts = [...text.matchAll(TIMESTAMP_LIKE)].length;
  const encodedStarts = [...text.matchAll(ENCODED_TIMESTAMP_LIKE)].length;
  return Math.max(0, starts - references.length) + encodedStarts;
}

function contextAt(text, start, end) {
  const before = text.slice(0, start);
  const tokenWindowStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  const tokenWindow = text.slice(tokenWindowStart, end);
  if (/^[^\s]*:\/\//.test(tokenWindow) || /(?:https?|discord):\/\/[^\s]*$/i.test(before.slice(Math.max(0, before.length - 256)))) {
    return "url";
  }
  if ((before.match(/```/g)?.length ?? 0) % 2 === 1) {
    return "fenced_code";
  }
  const withoutFences = before.replace(/```/g, "");
  if ((withoutFences.match(/(?<!\\)`/g)?.length ?? 0) % 2 === 1) {
    return "inline_code";
  }
  const left = text.slice(0, start).trimEnd().slice(-1);
  const right = text.slice(end).trimStart().slice(0, 1);
  if (
    (left === '"' && right === '"')
    || (left === "'" && right === "'")
    || (left === "“" && right === "”")
    || (left === "‘" && right === "’")
    || isInsideQuote(before, text.slice(end))
  ) {
    return "quoted";
  }
  return "plain";
}

function isInsideQuote(before, after) {
  return (
    (unescapedCharacterCount(before, '"') % 2 === 1 && after.includes('"'))
    || (unescapedCharacterCount(before, "'") % 2 === 1 && after.includes("'"))
    || (before.lastIndexOf("“") > before.lastIndexOf("”") && after.includes("”"))
    || (before.lastIndexOf("‘") > before.lastIndexOf("’") && after.includes("’"))
  );
}

function unescapedCharacterCount(text, character) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === character && (index === 0 || text[index - 1] !== "\\")) {
      count += 1;
    }
  }
  return count;
}

function aggregateContext(references) {
  const priority = ["url", "fenced_code", "inline_code", "quoted", "plain"];
  return priority.find((candidate) => references.some((reference) => reference.contextClass === candidate)) ?? "plain";
}

function semanticSignals(text) {
  const signals = [];
  const correctionText = text
    .replace(AFFIRMATIVE_CLOCK_CHANGE, " ")
    .replace(AFFIRMATIVE_TIMEZONE_CLOCK_CHANGE, " ");
  if (NEGATION_OR_CORRECTION.test(correctionText)) signals.push("negation_or_correction");
  if (CONDITIONAL_OR_UNCERTAIN.test(text)) signals.push("conditional_or_uncertain");
  if (COMPARISON.test(text)) signals.push("comparison");
  if (SCHEDULING.test(text)) signals.push("scheduling");
  if (TIMEZONE.test(text)) signals.push("timezone");
  if (DURATION.test(text)) signals.push("duration");
  if (SUBDAY_DURATION.test(text)) signals.push("subday_duration");
  return signals;
}

function isAffirmativePresentationProse(text, reference, residue) {
  const prefix = text.slice(0, reference.start);
  if (!PRESENTATION_ANCHOR.test(prefix)) return false;
  if (hasMalformedRelationalClock(text.slice(reference.end))) return false;
  if (NEGATION_OR_CORRECTION.test(text) || CONDITIONAL_OR_UNCERTAIN.test(text) || COMPARISON.test(text) || SCHEDULING.test(text) || TIMEZONE.test(text)) {
    return false;
  }
  if (OTHER_TEMPORAL_ENTITY.test(residue)) return false;
  return !/[<>]/.test(residue);
}

function hasMalformedRelationalClock(text) {
  for (const match of text.matchAll(/\b(?:ends?|finishes?)\s+at\s+(\d+(?:[:.]\d+)*(?:\s*[ap](?:\.?m\.?)?)?)/giu)) {
    const token = match[1];
    if (!new RegExp(String.raw`^${CLOCK_SOURCE}$`, 'iu').test(token)) return true;
  }
  return false;
}

function inputLengthBucket(length) {
  if (length <= 64) return "0-64";
  if (length <= 256) return "65-256";
  if (length <= 1024) return "257-1024";
  if (length <= 4096) return "1025-4096";
  if (length <= 16384) return "4097-16384";
  return "over-16384";
}

function parseDiscordTimestampAmount(value) {
  const normalized = value.toLowerCase().trim().replace(/-/g, " ").replace(/\s+/g, " ");
  if (/^\d{1,3}$/.test(normalized)) return Number(normalized);
  const values = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  if (values[normalized] !== undefined) return values[normalized];
  const [tensWord, onesWord] = normalized.split(" ");
  const tens = values[tensWord];
  const ones = values[onesWord];
  return tens >= 20 && tens % 10 === 0 && ones > 0 && ones < 10 ? tens + ones : null;
}

module.exports = {
  DISCORD_TIMESTAMP_CLASSIFIER_VERSION,
  DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS,
  DISCORD_TIMESTAMP_MAX_INPUT_CHARS,
  DISCORD_TIMESTAMP_MAX_MODEL_CHARS,
  DISCORD_TIMESTAMP_AMOUNT_SOURCE,
  classifyDiscordTimestampInput,
  discordTimestampFormatIndex,
  discordTimestampFormatCode,
  parseDiscordTimestampAmount,
};
