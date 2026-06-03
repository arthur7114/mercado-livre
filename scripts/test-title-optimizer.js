const assert = require('assert');
const {
  normalizeRawTitle,
  extractTitleAttributes,
  buildDeterministicTitle,
  validateAiTitle,
  normalizeAiRegistration,
  isHumanGateRequired
} = require('../lib/titleOptimizer');

function buildContext(title, extra = {}) {
  const normalized = normalizeRawTitle(title);
  const attributes = extractTitleAttributes(title, {
    normalizedTitle: normalized.normalizedTitle,
    removedTerms: normalized.removedTerms
  });
  const fallbackTitle = buildDeterministicTitle({ title, attributes });

  return {
    originalTitle: title,
    normalizedTitle: normalized.normalizedTitle,
    sku: extra.sku || '',
    category: extra.category || '',
    dictionaryText: '',
    attributes,
    fallbackTitle,
    removedTerms: normalized.removedTerms,
    humanGate: isHumanGateRequired(attributes, title)
  };
}

function assertFallbackTitle(input, expected) {
  const context = buildContext(input);
  assert.strictEqual(context.fallbackTitle, expected, input);
  assert.ok(context.fallbackTitle.length <= 60, `${input} excedeu 60 caracteres`);
}

assertFallbackTitle(
  'Bolsa Feminina Em P.U. Moderna FB-282 M',
  'Bolsa Feminina Moderna PU FB-282 M'
);

assertFallbackTitle(
  'Bolsa Feminina em P.U. FB-281 P - Modave Estilo',
  'Bolsa Feminina Modave PU FB-281 P'
);

assertFallbackTitle(
  'Estojo Duplo Fb Est 300',
  'Estojo Duplo FB EST 300'
);

assertFallbackTitle(
  'Sacola De Viagem Fb 05',
  'Sacola De Viagem FB 05'
);

{
  const context = buildContext('Produto Teste ABC-998');
  assert.strictEqual(context.humanGate, true, 'Produto Teste ABC-998 deve exigir revisão humana');
}

{
  const context = buildContext('Kit 123');
  assert.strictEqual(context.humanGate, true, 'Kit 123 deve exigir revisão humana');
}

{
  const context = buildContext('Estojo Duplo Fb Est 300');
  const validation = validateAiTitle({
    tituloOtimizado: 'Estojo duplo FB Est 300 para escolares e escritorio',
    termosRemovidos: []
  }, context);

  assert.strictEqual(validation.valid, false, 'Deve reprovar termos inventados');
  assert.ok(validation.flags.includes('invented_term'), 'Deve marcar invented_term');
}

{
  const context = buildContext('Bolsa Feminina Em P.U. Moderna FB-282 M');
  const validation = validateAiTitle({
    tituloOtimizado: 'Bolsa Feminina Moderna PU FB-282 M',
    termosRemovidos: ['FB-282', 'Em']
  }, context);

  assert.strictEqual(validation.valid, true, 'Título válido não deveria reprovar');
  assert.deepStrictEqual(validation.termosRemovidos, ['Em'], 'Não deve reportar removido que ainda aparece');
}

{
  const context = buildContext('Bolsa Feminina em P.U. FB-281 P - Modave Estilo');
  const validation = validateAiTitle({
    tituloOtimizado: 'Bolsa Feminina Modave PU FB-281 P',
    termosRemovidos: ['Estilo']
  }, context);
  const registration = normalizeAiRegistration({
    tituloOtimizado: 'Bolsa Feminina Modave PU FB-281 P',
    status: 'ok',
    confidence: 0.95,
    humanGate: true,
    problemasDetectados: ['preciso, consistente'],
    termosRemovidos: ['Estilo']
  }, context, 'ai_fast', validation);

  assert.strictEqual(validation.valid, true, 'Título do print deve passar nos guardrails');
  assert.strictEqual(registration.status, 'ok', 'Human gate indevido da IA deve ser corrigido');
  assert.strictEqual(registration.humanGate, false, 'Não deve mostrar human gate sem problema real');
  assert.deepStrictEqual(registration.problemasDetectados, [], 'Não deve mostrar termos positivos como problema');
}

console.log('title optimizer tests passed');
