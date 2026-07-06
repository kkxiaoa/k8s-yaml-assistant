import type Anthropic from '@anthropic-ai/sdk';

/** 调一次模型,把 text block 拼成纯字符串返回。 */
export async function textOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}
