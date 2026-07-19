import type Anthropic from '@anthropic-ai/sdk';

export const TEXT_MAX_TOKENS = 1024;

export async function textOfRequest(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<string> {
  const response = await client.messages.create(request);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 调一次模型,把 text block 拼成纯字符串返回。 */
export async function textOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  return textOfRequest(client, {
    model,
    max_tokens: TEXT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
}
