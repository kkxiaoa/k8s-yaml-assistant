import type Anthropic from '@anthropic-ai/sdk';

export interface ModelResponseMetadata {
  stopReason: unknown;
  textBlockCount: number;
  nonTextBlockCount: number;
}

export interface ModelTextResponse {
  text: string;
  metadata: ModelResponseMetadata;
}

type ModelMessage = Pick<Anthropic.Message, 'content' | 'stop_reason'>;

export function modelResponseMetadata(
  response: ModelMessage,
): ModelResponseMetadata {
  const textBlockCount = response.content.filter(
    (block) => block.type === 'text',
  ).length;
  return {
    stopReason: response.stop_reason,
    textBlockCount,
    nonTextBlockCount: response.content.length - textBlockCount,
  };
}

export function modelTextResponse(response: ModelMessage): ModelTextResponse {
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  return { text, metadata: modelResponseMetadata(response) };
}

function diagnosticStopReason(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value)
    ? value
    : 'unknown';
}

export function requireModelText(response: ModelTextResponse): string {
  if (/\S/.test(response.text)) return response.text;
  const { stopReason, textBlockCount, nonTextBlockCount } = response.metadata;
  throw new Error(
    `model response contained no text: stop_reason=${diagnosticStopReason(stopReason)}, text_blocks=${textBlockCount}, non_text_blocks=${nonTextBlockCount}`,
  );
}
