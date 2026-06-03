const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const tempDir = path.join(os.tmpdir(), `optimizer-memory-${Date.now()}`);
process.env.OPTIMIZER_MEMORY_FILE = path.join(tempDir, 'memory.json');

const {
  addOptimizationMemory,
  getMemorySnapshot,
  buildMemoryPrompt,
  clearOptimizationMemory
} = require('../lib/optimizerMemory');

(async () => {
  await clearOptimizationMemory();

  const ignored = await addOptimizationMemory({
    originalTitle: 'Bolsa Feminina PU FB-281 P',
    optimizedTitle: 'Bolsa Feminina PU FB-281 P'
  });
  assert.strictEqual(ignored.saved, false, 'Não deve salvar exemplo sem melhoria');

  const saved = await addOptimizationMemory({
    productId: '1282',
    sku: '1282',
    originalTitle: 'Bolsa Feminina em P.U. FB-281 P - Modave Estilo',
    optimizedTitle: 'Bolsa Feminina Modave PU FB-281 P',
    optimizedDescription: 'Bolsa Feminina Modave. Material: PU. Referencia/modelo: FB-281. Tamanho: P.',
    usedAttributes: ['Bolsa Feminina', 'Modave', 'PU', 'FB-281', 'P']
  });
  assert.strictEqual(saved.saved, true, 'Deve salvar exemplo aceito');

  await addOptimizationMemory({
    productId: '1282',
    sku: '1282',
    originalTitle: 'Bolsa Feminina em P.U. FB-281 P - Modave Estilo',
    optimizedTitle: 'Bolsa Feminina Modave PU FB-281 P'
  });

  const snapshot = await getMemorySnapshot({ limit: 5 });
  assert.strictEqual(snapshot.total, 1, 'Deve deduplicar exemplos iguais');
  assert.strictEqual(snapshot.storage.persistent, true, 'Teste deve usar arquivo persistente');

  const prompt = buildMemoryPrompt(snapshot);
  assert.ok(prompt.includes('Original:'), 'Prompt deve incluir título original');
  assert.ok(prompt.includes('Aceito:'), 'Prompt deve incluir título aceito');

  await fs.rm(tempDir, { recursive: true, force: true });
  console.log('optimizer memory tests passed');
})().catch(async error => {
  await fs.rm(tempDir, { recursive: true, force: true });
  throw error;
});
