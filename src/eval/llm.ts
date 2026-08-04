import type Anthropic from '@anthropic-ai/sdk';

export const TEXT_MAX_TOKENS = 1024;

interface ModelResponseMetadata {
  stopReason: unknown;
  textBlockCount: number;
  nonTextBlockCount: number;
}

interface ModelTextResponse {
  text: string;
  metadata: ModelResponseMetadata;
}

interface ModelToolResponse {
  inputs: unknown[];
  metadata: ModelResponseMetadata;
}

function responseMetadata(response: Anthropic.Message): ModelResponseMetadata {
  const textBlockCount = response.content.filter(
    (block) => block.type === 'text',
  ).length;
  return {
    stopReason: response.stop_reason,
    textBlockCount,
    nonTextBlockCount: response.content.length - textBlockCount,
  };
}

async function modelTextResponseOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<ModelTextResponse> {
  const response = await client.messages.create(request);
  const textBlocks = response.content.filter(
    (block) => block.type === 'text',
  );
  return {
    text: textBlocks.map((block) => block.text).join(''),
    metadata: responseMetadata(response),
  };
}

export async function toolResponseOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
  toolName: string,
): Promise<ModelToolResponse> {
  const response = await client.messages.create(request);
  return {
    inputs: response.content.flatMap((block) =>
      block.type === 'tool_use' && block.name === toolName
        ? [block.input]
        : [],
    ),
    metadata: responseMetadata(response),
  };
}

export async function textOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<string> {
  return (await modelTextResponseOfRequest(client, request)).text;
}

export async function textResponseOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens = TEXT_MAX_TOKENS,
): Promise<ModelTextResponse> {
  return modelTextResponseOfRequest(client, {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
}

/** 调一次模型,把 text block 拼成纯字符串返回。 */
export async function textOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  return (await textResponseOf(client, model, system, user)).text;
}
