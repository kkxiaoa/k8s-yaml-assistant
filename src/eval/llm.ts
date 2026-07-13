import type Anthropic from '@anthropic-ai/sdk';

export const TEXT_MAX_TOKENS = 1024;

/** 调一次模型,把 text block 拼成纯字符串返回。 */
export async function textOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const resp = await client.messages.create({
    model,
    max_tokens: TEXT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}
