import type Anthropic from '@anthropic-ai/sdk';
import {
  modelResponseMetadata,
  modelTextResponse,
  requireModelText,
  type ModelResponseMetadata,
  type ModelTextResponse,
} from '../server/model-response';

export const TEXT_MAX_TOKENS = 1024;

interface ModelToolResponse {
  inputs: unknown[];
  metadata: ModelResponseMetadata;
}

async function modelTextResponseOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<ModelTextResponse> {
  const response = await client.messages.create(request);
  return modelTextResponse(response);
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
    metadata: modelResponseMetadata(response),
  };
}

export async function textOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<string> {
  return requireModelText(await modelTextResponseOfRequest(client, request));
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
  return requireModelText(await textResponseOf(client, model, system, user));
}
