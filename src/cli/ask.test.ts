import assert from 'node:assert/strict';
import {
  retrieveAskDocuments,
  type AskRetriever,
} from './ask';

const delegated = new Error('shared retriever called');
let calls = 0;
const retriever: AskRetriever = async (question, k) => {
  calls++;
  assert.equal(question, 'reclaimPolicy 能填哪些值?');
  assert.equal(k, 3);
  throw delegated;
};

await assert.rejects(
  () => retrieveAskDocuments('reclaimPolicy 能填哪些值?', retriever),
  (error: unknown) => error === delegated,
);
assert.equal(calls, 1);

console.log('ask CLI: shared retrieval delegation verified');
