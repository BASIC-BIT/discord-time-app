import { parseTemporalExpression } from '../src/temporal/index';

async function main() {
  const baseUrl = process.env.HOSTED_SLM_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.HOSTED_SLM_API_KEY;
  if (baseUrl !== 'https://lvddpcgo2rizu8.api.runpod.ai/v1' || !apiKey) {
    throw new Error('Unexpected RunPod endpoint or missing scoped credential');
  }
  const result = await parseTemporalExpression({
    text: 'easter', timeZone: 'America/Indianapolis', referenceInstant: '2026-11-27T20:30:46.500Z',
    features: { planIr: true, deterministicPreflight: false, discordReferenceRouting: true },
    planIrEndpoint: {
      baseUrl, apiKey, model: 'qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22',
      instructionPreset: 'minimal', api: 'chat', promptFormat: 'chat', maxTokens: 512, timeoutMs: 150000,
    },
  });
  console.log(JSON.stringify({
    status: result.status, validation: result.validation, canonical: result.canonical,
    trace: result.debug?.trace?.map(({ name, output }) => ({ name, output })),
  }));
  if (!result.debug?.trace?.some(step => step.name === 'local_endpoint_plan')) process.exitCode = 2;
}

void main();
