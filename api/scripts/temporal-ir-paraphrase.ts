import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';
import { TemporalPlanPlannerSchema, type TemporalPlanPlannerOutput } from '../src/temporal/plan-ir';

type Split = 'train' | 'validation' | 'holdout';

type TemporalIrTrainingRow = {
  id: string;
  split: Split;
  tags: string[];
  input: {
    text: string;
    referenceInstant: string;
    timeZone: string;
  };
  output: TemporalPlanPlannerOutput;
  sourceId?: string;
  generatedBy?: string;
};

const ParaphraseBatchSchema = z.object({
  paraphrases: z.array(z.object({
    text: z.string().min(1),
    tags: z.array(z.string()),
    note: z.string(),
  })).min(1).max(20),
});

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultInputPath = join(apiRoot, 'reports', 'temporal-ml', 'temporal-ir-seeds.jsonl');
const defaultOutputPath = join(apiRoot, 'reports', 'temporal-ml', 'temporal-ir-expanded.jsonl');
const inputPath = process.env['TEMPORAL_IR_PARAPHRASE_INPUT'] ?? defaultInputPath;
const outputPath = process.env['TEMPORAL_IR_PARAPHRASE_OUTPUT'] ?? defaultOutputPath;
const limit = parsePositiveInt(process.env['TEMPORAL_IR_PARAPHRASE_LIMIT']);
const paraphrasesPerRow = parsePositiveInt(process.env['TEMPORAL_IR_PARAPHRASES_PER_ROW']) ?? 4;
const sourceSplit = parseSplit(process.env['TEMPORAL_IR_PARAPHRASE_SOURCE_SPLIT']) ?? 'train';
const generatedSplit = parseSplit(process.env['TEMPORAL_IR_PARAPHRASE_GENERATED_SPLIT']);
const dryRun = isTruthy(process.env['TEMPORAL_IR_PARAPHRASE_DRY_RUN']);
const openaiApiKey = nonBlank(process.env['OPENAI_API_KEY']);
const modelName = process.env['TEMPORAL_IR_PARAPHRASE_MODEL'] ?? process.env['OPENAI_MODEL'] ?? 'gpt-5.5';
const reasoningEffort = process.env['OPENAI_REASONING_EFFORT'] ?? 'low';

async function main() {
  const seedRows = (await readJsonl(inputPath)).map(validateRow);
  const sourceRows = seedRows.filter((row) => row.split === sourceSplit);
  const selectedRows = limit === undefined ? sourceRows : sourceRows.slice(0, limit);
  const outputRows: TemporalIrTrainingRow[] = [...seedRows];

  if (dryRun) {
    console.log('Dry run enabled; wrote seed rows only.');
  } else {
    if (openaiApiKey === undefined) {
      throw new Error('OPENAI_API_KEY is required unless TEMPORAL_IR_PARAPHRASE_DRY_RUN=1.');
    }
    const model = createChatModel().withStructuredOutput(ParaphraseBatchSchema);
    for (const row of selectedRows) {
      const batch = await model.invoke([
        new SystemMessage(systemPrompt()),
        new HumanMessage(JSON.stringify({ row, paraphrasesPerRow })),
      ]);
      for (const [index, paraphrase] of batch.paraphrases.entries()) {
        outputRows.push(validateRow({
          ...row,
          id: `${row.id}__p${index + 1}`,
          split: generatedSplit ?? row.split,
          tags: unique([...row.tags, ...paraphrase.tags, 'llm-paraphrase']),
          input: { ...row.input, text: paraphrase.text },
          sourceId: row.id,
          generatedBy: modelName,
        }));
      }
      console.log(`Generated ${batch.paraphrases.length} paraphrases for ${row.id}`);
    }
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${outputRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  console.log(`Wrote ${outputRows.length} Temporal IR rows to ${outputPath}`);
}

function systemPrompt(): string {
  return `Create training paraphrases for a temporal semantic parser.

The model being trained maps user text to Temporal Plan-IR JSON. You will receive one row containing input text and the exact target Plan-IR. Produce paraphrases that preserve the exact semantic target.

Rules:
- Return only structured output matching the schema.
- Generate the requested number of paraphrases.
- Preserve ambiguity. If the target is clarification, every paraphrase must still require the same clarification.
- Preserve all date, time, holiday, weekday, offset, and timezone semantics.
- Do not introduce new temporal signals that are absent from the target IR.
- Include natural user phrasing, casing variation, punctuation variation, short text, and mild typos only when the meaning stays the same.
- Do not include raw Discord timestamp syntax unless the source already uses it.
- Do not add explanations outside the structured fields.`;
}

function createChatModel(): ChatOpenAI {
  if (modelName.startsWith('gpt-5')) {
    return new ChatOpenAI({
      apiKey: openaiApiKey,
      model: modelName,
      reasoning: { effort: normalizeReasoningEffort(reasoningEffort), summary: 'auto' },
      useResponsesApi: true,
    });
  }
  return new ChatOpenAI({ apiKey: openaiApiKey, model: modelName, temperature: 0.7 });
}

async function readJsonl(path: string): Promise<TemporalIrTrainingRow[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TemporalIrTrainingRow);
}

function validateRow(row: TemporalIrTrainingRow): TemporalIrTrainingRow {
  return {
    ...row,
    output: TemporalPlanPlannerSchema.parse(row.output),
  };
}

function normalizeReasoningEffort(effort: string): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'none' || effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'low';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseSplit(value: string | undefined): Split | undefined {
  if (value === 'train' || value === 'validation' || value === 'holdout') {
    return value;
  }
  return undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes' || value?.toLowerCase() === 'on';
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
