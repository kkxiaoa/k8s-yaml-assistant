// 远程 embedding API 客户端。迭代0 用 Voyage AI(Anthropic 官方推荐的 embedding 提供商)。
// 故意只暴露一个 embed() 函数,方便迭代3 换成别的提供商或本地模型而不动其他代码。

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

/** 解析当前 embedding 模型:env VOYAGE_EMBEDDING_MODEL 优先,默认 voyage-3。 */
export function resolveEmbeddingModel(): string {
  return process.env.VOYAGE_EMBEDDING_MODEL ?? 'voyage-3';
}

/** 当前 embedding 模型名。索引 indexHash 依赖它:换模型即让旧索引失效。 */
export const EMBEDDING_MODEL = resolveEmbeddingModel();
const MAX_BATCH_SIZE = 1000;

interface VoyageResponse {
  data: { embedding: number[] }[];
}

/**
 * 把一批文本转成向量。
 * @param texts 待编码的文本数组
 * @param inputType "document"(入库的语料)或 "query"(用户问题)——Voyage 会据此微调编码,提升检索质量
 */
export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
  model: string = resolveEmbeddingModel(),
): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error('VOYAGE_API_KEY 未设置。复制 .env.example 为 .env 并填入,或 export VOYAGE_API_KEY=...');
  }

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ input: batch, model, input_type: inputType }),
    });

    if (!res.ok) {
      throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as VoyageResponse;
    out.push(...json.data.map((d) => d.embedding));
  }
  return out;
}
