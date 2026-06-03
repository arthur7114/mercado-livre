const MAX_TITLE_LENGTH = 60;

const STOPWORDS = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'por', 'com', 'e'
]);

const NOISE_TOKENS = new Set([
  'produto', 'cadastro', 'teste', 'ml', 'novo', 'nova', 'estilo'
]);

const PROHIBITED_INFERENCES = new Set([
  'escolar', 'escolares', 'escritorio', 'infantil', 'profissional',
  'premium', 'top', 'melhor', 'perfeito', 'garantido', 'original'
]);

const KNOWN_MATERIALS = new Map([
  ['pu', 'PU'],
  ['p u', 'PU'],
  ['p.u', 'PU'],
  ['p.u.', 'PU'],
  ['couro', 'Couro'],
  ['plastico', 'Plastico'],
  ['algodao', 'Algodao'],
  ['poliester', 'Poliester']
]);

const KNOWN_SIZES = new Set(['PP', 'P', 'M', 'G', 'GG', 'XG', 'XXG']);

const PRODUCT_TYPE_PATTERNS = [
  { match: ['bolsa', 'feminina'], value: 'Bolsa Feminina' },
  { match: ['bolsa', 'masculina'], value: 'Bolsa Masculina' },
  { match: ['estojo', 'duplo'], value: 'Estojo Duplo' },
  { match: ['estojo'], value: 'Estojo' },
  { match: ['mochila'], value: 'Mochila' },
  { match: ['necessaire'], value: 'Necessaire' },
  { match: ['carteira'], value: 'Carteira' },
  { match: ['cinto'], value: 'Cinto' },
  { match: ['kit'], value: 'Kit' }
];

const STYLE_WORDS = new Set([
  'moderna', 'moderno', 'classica', 'classico', 'casual', 'social'
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeForComparison(value) {
  return normalizeString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function titleCase(value) {
  const token = normalizeString(value);
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function compactTitle(value, limit = MAX_TITLE_LENGTH) {
  const normalized = normalizeString(value).replace(/\s+/g, ' ');
  if (normalized.length <= limit) return normalized;

  const sliced = normalized.slice(0, limit).trim();
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > 35 ? sliced.slice(0, lastSpace).trim() : sliced;
}

function formatToken(token) {
  const cleanToken = normalizeString(token).replace(/[.,;:()[\]{}]/g, '');
  if (!cleanToken) return '';

  const compactToken = cleanToken.replace(/\./g, '').toUpperCase();
  if (KNOWN_SIZES.has(compactToken) || ['PU', 'FB', 'EST', 'REF'].includes(compactToken)) {
    return compactToken;
  }

  if (/[A-Za-z]+-\d+/.test(cleanToken) || /\d/.test(cleanToken)) {
    return cleanToken.toUpperCase();
  }

  if (/^[a-z]{1,3}$/i.test(cleanToken)) {
    return cleanToken.toUpperCase();
  }

  return titleCase(cleanToken);
}

function tokenizeTitle(value) {
  return normalizeString(value)
    .replace(/\s+[-–—]+\s+/g, ' ')
    .replace(/\bP\s*\.?\s*U\.?\b/gi, 'PU')
    .replace(/[|_/]+/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function applyDictionary(title, dictionary = []) {
  let result = normalizeString(title);
  const removedTerms = [];
  const replacedTerms = [];

  if (!Array.isArray(dictionary)) {
    return { title: result, removedTerms, replacedTerms };
  }

  dictionary
    .filter(entry => normalizeString(entry?.from))
    .sort((a, b) => normalizeString(b.from).length - normalizeString(a.from).length)
    .forEach(entry => {
      const from = normalizeString(entry.from);
      const to = normalizeString(entry.to);
      const regex = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi');

      if (!regex.test(result)) return;
      result = result.replace(regex, to);

      if (to) {
        replacedTerms.push(`${from} -> ${to}`);
      } else {
        removedTerms.push(from);
      }
    });

  return {
    title: result.replace(/\s+/g, ' ').trim(),
    removedTerms,
    replacedTerms
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRawTitle(title) {
  const removedTerms = [];
  const sourceTokens = tokenizeTitle(title);
  const normalizedTokens = [];

  sourceTokens.forEach((token, index) => {
    const comparisonToken = normalizeForComparison(token);
    const nextToken = normalizeForComparison(sourceTokens[index + 1] || '');

    if (!comparisonToken || NOISE_TOKENS.has(comparisonToken)) {
      if (comparisonToken) removedTerms.push(token);
      return;
    }

    if (comparisonToken === 'em' && ['pu', 'p', 'p u'].includes(nextToken)) {
      removedTerms.push(token);
      return;
    }

    normalizedTokens.push(formatToken(token));
  });

  return {
    normalizedTitle: normalizedTokens.join(' ').replace(/\s+/g, ' ').trim(),
    removedTerms: [...new Set(removedTerms)]
  };
}

function extractTitleAttributes(title, options = {}) {
  const normalizedTitle = normalizeString(options.normalizedTitle) || normalizeRawTitle(title).normalizedTitle;
  const tokens = normalizedTitle.split(/\s+/).filter(Boolean);
  const normalizedTokens = tokens.map(normalizeForComparison);
  const usedIndexes = new Set();

  const attributes = {
    tipoProduto: '',
    marca: '',
    modeloReferencia: '',
    material: '',
    tamanho: '',
    cor: '',
    quantidade: '',
    atributos: [],
    ruidos: [...(options.removedTerms || [])]
  };

  const productPattern = PRODUCT_TYPE_PATTERNS.find(pattern =>
    pattern.match.every(part => normalizedTokens.includes(part))
  );
  if (productPattern) {
    attributes.tipoProduto = productPattern.value;
    productPattern.match.forEach(part => {
      const index = normalizedTokens.indexOf(part);
      if (index >= 0) usedIndexes.add(index);
    });
  }

  const materialIndex = normalizedTokens.findIndex(token => KNOWN_MATERIALS.has(token));
  if (materialIndex >= 0) {
    attributes.material = KNOWN_MATERIALS.get(normalizedTokens[materialIndex]);
    usedIndexes.add(materialIndex);
  }

  const sizeIndex = tokens.findIndex((token, index) => {
    const formattedToken = formatToken(token);
    return KNOWN_SIZES.has(formattedToken) && index >= tokens.length - 2;
  });
  if (sizeIndex >= 0) {
    attributes.tamanho = formatToken(tokens[sizeIndex]);
    usedIndexes.add(sizeIndex);
  }

  const modelParts = [];
  tokens.forEach((token, index) => {
    const formatted = formatToken(token);
    const nextFormatted = formatToken(tokens[index + 1] || '');
    if (formatted === attributes.material || formatted === attributes.tamanho || KNOWN_MATERIALS.has(normalizedTokens[index])) {
      return;
    }

    const isCode = /[A-Z]+-\d+[A-Z]?/.test(formatted)
      || (/^[A-Z]{2,4}$/.test(formatted) && /\d/.test(nextFormatted))
      || (/^[A-Z]{2,4}$/.test(formatted) && /^[A-Z]{2,4}$/.test(nextFormatted) && /\d/.test(formatToken(tokens[index + 2] || '')));

    if (!isCode) return;

    modelParts.push(formatted);
    usedIndexes.add(index);

    if (nextFormatted && !modelParts.includes(nextFormatted) && (/^\d/.test(nextFormatted) || /^[A-Z]{2,4}$/.test(nextFormatted))) {
      modelParts.push(nextFormatted);
      usedIndexes.add(index + 1);
    }

    const thirdFormatted = formatToken(tokens[index + 2] || '');
    if (thirdFormatted && /^\d/.test(thirdFormatted) && !modelParts.includes(thirdFormatted)) {
      modelParts.push(thirdFormatted);
      usedIndexes.add(index + 2);
    }
  });
  attributes.modeloReferencia = [...new Set(modelParts)].join(' ');

  tokens.forEach((token, index) => {
    if (usedIndexes.has(index)) return;

    const comparisonToken = normalizedTokens[index];
    const formatted = formatToken(token);

    if (STOPWORDS.has(comparisonToken) || NOISE_TOKENS.has(comparisonToken)) return;

    if (STYLE_WORDS.has(comparisonToken)) {
      attributes.atributos.push(formatted);
      usedIndexes.add(index);
      return;
    }

    if (!attributes.marca && /^[A-Z][a-z]/.test(token) && formatted.length > 3) {
      attributes.marca = formatted;
      usedIndexes.add(index);
    }
  });

  return attributes;
}

function buildDeterministicTitle(input) {
  const attributes = input?.attributes || extractTitleAttributes(input?.title || '');
  const parts = [
    attributes.tipoProduto,
    attributes.marca,
    ...(attributes.atributos || []),
    attributes.material,
    attributes.modeloReferencia,
    attributes.tamanho,
    attributes.cor,
    attributes.quantidade
  ].filter(Boolean);

  const fallbackTitle = parts.length > 0
    ? parts.join(' ')
    : normalizeRawTitle(input?.title || '').normalizedTitle;

  return compactTitle(fallbackTitle);
}

function getAllowedTokens(context) {
  const values = [
    context.originalTitle,
    context.normalizedTitle,
    context.sku,
    context.category,
    context.dictionaryText,
    context.fallbackTitle,
    ...Object.values(context.attributes || {}).flat()
  ];

  return extractNormalizedTokens(values.filter(Boolean).join(' '));
}

function extractNormalizedTokens(value) {
  const tokens = normalizeForComparison(value).split(' ').filter(Boolean);
  const tokenSet = new Set(tokens);

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].length === 1 && tokens[index + 1].length === 1) {
      tokenSet.add(`${tokens[index]}${tokens[index + 1]}`);
    }
  }

  return tokenSet;
}

function validateAiTitle(aiData, context) {
  const title = normalizeString(aiData?.tituloOtimizado);
  const flags = [];
  const problems = [];
  const allowedTokens = getAllowedTokens(context);
  const ignoredTokens = new Set([...STOPWORDS, 'un', 'und']);

  if (!title) {
    flags.push('empty_title');
    problems.push('A IA não gerou título.');
  }

  if (title.length > MAX_TITLE_LENGTH) {
    flags.push('too_long');
    problems.push('Título acima de 60 caracteres.');
  }

  const titleTokens = extractNormalizedTokens(title);
  const inventedTokens = [...titleTokens]
    .filter(token => token.length > 2)
    .filter(token => !allowedTokens.has(token))
    .filter(token => !ignoredTokens.has(token));

  if (inventedTokens.length > 0) {
    flags.push('invented_term');
    problems.push(`Título contém termos não sustentados pelos dados: ${inventedTokens.join(', ')}.`);
  }

  const prohibitedTokens = [...titleTokens].filter(token => PROHIBITED_INFERENCES.has(token) && !allowedTokens.has(token));
  if (prohibitedTokens.length > 0) {
    flags.push('invented_term');
    problems.push(`Título contém inferências proibidas: ${prohibitedTokens.join(', ')}.`);
  }

  if (context.attributes?.modeloReferencia && !containsNormalizedToken(title, context.attributes.modeloReferencia)) {
    flags.push('lost_model');
    problems.push('Título removeu modelo/referência útil.');
  }

  if (context.attributes?.marca && !containsNormalizedToken(title, context.attributes.marca)) {
    flags.push('lost_brand');
    problems.push('Título removeu marca identificada.');
  }

  if (context.attributes?.material && !containsNormalizedToken(title, context.attributes.material)) {
    flags.push('lost_material');
    problems.push('Título removeu material identificado.');
  }

  if (context.attributes?.tamanho && !containsNormalizedToken(title, context.attributes.tamanho)) {
    flags.push('lost_size');
    problems.push('Título removeu tamanho identificado.');
  }

  if (context.attributes?.modeloReferencia && titleTokens.size <= 3) {
    flags.push('too_generic');
    problems.push('Título ficou genérico para um produto com referência/modelo.');
  }

  const filteredRemovedTerms = normalizeStringArray(aiData?.termosRemovidos)
    .filter(term => !containsNormalizedToken(title, term));

  return {
    valid: flags.length === 0,
    flags: [...new Set(flags)],
    problems: [...new Set(problems)],
    termosRemovidos: filteredRemovedTerms
  };
}

function containsNormalizedToken(haystack, needle) {
  const normalizedNeedle = normalizeForComparison(needle);
  if (!normalizedNeedle) return true;

  const haystackTokens = extractNormalizedTokens(haystack);
  return normalizedNeedle
    .split(' ')
    .filter(token => token.length > 1)
    .every(token => haystackTokens.has(token));
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map(item => normalizeString(item)).filter(Boolean)
    : [];
}

function normalizeAiRegistration(aiData, context, source, validation) {
  const attributes = context.attributes || {};
  const qualityFlags = [
    ...normalizeStringArray(aiData?.qualityFlags),
    ...(validation?.flags || [])
  ];
  const problems = [
    ...normalizeStringArray(aiData?.problemasDetectados),
    ...(validation?.problems || [])
  ];
  const humanGate = Boolean(aiData?.humanGate) || qualityFlags.length > 0 || Number(aiData?.confidence) < 0.70;
  const status = aiData?.status === 'blocked'
    ? 'blocked'
    : humanGate
      ? 'needs_review'
      : 'ok';
  const finalTitle = compactTitle(aiData?.tituloOtimizado || context.fallbackTitle);
  const removedTerms = [
    ...(context.removedTerms || []),
    ...(validation?.termosRemovidos || normalizeStringArray(aiData?.termosRemovidos))
  ].filter(term => !containsNormalizedToken(finalTitle, term));

  return {
    tituloOtimizado: finalTitle,
    status,
    confidence: clampConfidence(aiData?.confidence ?? (source === 'fallback' ? 0.65 : 0.80)),
    humanGate,
    motivoHumanGate: normalizeString(aiData?.motivoHumanGate) || (humanGate ? 'Revisão humana recomendada pelos guardrails de qualidade.' : ''),
    problemasDetectados: [...new Set(problems)],
    atributosIdentificados: {
      marca: normalizeString(aiData?.atributosIdentificados?.marca) || attributes.marca || '',
      tipoProduto: normalizeString(aiData?.atributosIdentificados?.tipoProduto) || attributes.tipoProduto || '',
      modelo: normalizeString(aiData?.atributosIdentificados?.modelo) || attributes.modeloReferencia || '',
      cor: normalizeString(aiData?.atributosIdentificados?.cor) || attributes.cor || '',
      tamanho: normalizeString(aiData?.atributosIdentificados?.tamanho) || attributes.tamanho || '',
      quantidade: normalizeString(aiData?.atributosIdentificados?.quantidade) || attributes.quantidade || '',
      material: normalizeString(aiData?.atributosIdentificados?.material) || attributes.material || '',
      compatibilidade: normalizeString(aiData?.atributosIdentificados?.compatibilidade) || '',
      voltagem: normalizeString(aiData?.atributosIdentificados?.voltagem) || '',
      outros: normalizeStringArray(aiData?.atributosIdentificados?.outros)
    },
    termosRemovidos: [...new Set(removedTerms)],
    observacoes: normalizeString(aiData?.observacoes),
    generationSource: source,
    qualityFlags: [...new Set(qualityFlags)],
    usedAttributes: buildUsedAttributes(attributes)
  };
}

function buildFallbackRegistration(context, source = 'fallback', extraProblems = []) {
  const validation = {
    flags: ['fallback'],
    problems: extraProblems,
    termosRemovidos: context.removedTerms || []
  };

  return normalizeAiRegistration({
    tituloOtimizado: context.fallbackTitle,
    status: 'needs_review',
    confidence: context.humanGate ? 0.55 : 0.68,
    humanGate: true,
    motivoHumanGate: context.humanGate
      ? 'Dados insuficientes ou ambíguos; confira antes de salvar.'
      : 'Fallback seguro usado porque a IA não passou nos guardrails.',
    problemasDetectados: extraProblems,
    termosRemovidos: context.removedTerms || [],
    observacoes: 'Título gerado por regra local para evitar invenções.'
  }, context, source, validation);
}

function buildUsedAttributes(attributes = {}) {
  return [
    attributes.tipoProduto,
    attributes.marca,
    ...(attributes.atributos || []),
    attributes.material,
    attributes.modeloReferencia,
    attributes.tamanho,
    attributes.cor,
    attributes.quantidade
  ].filter(Boolean);
}

function clampConfidence(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 0;
  return Math.min(1, Math.max(0, numericValue));
}

function isHumanGateRequired(attributes, title) {
  const normalizedTitle = normalizeForComparison(title);
  const hasOnlyGenericType = ['kit', 'produto teste', 'cadastro'].some(term => normalizedTitle.includes(term));
  const hasUsefulIdentifier = Boolean(
    attributes.tipoProduto && (attributes.modeloReferencia || attributes.marca || attributes.material || attributes.tamanho || attributes.atributos.length)
  );

  return hasOnlyGenericType || !hasUsefulIdentifier;
}

module.exports = {
  MAX_TITLE_LENGTH,
  applyDictionary,
  normalizeRawTitle,
  extractTitleAttributes,
  buildDeterministicTitle,
  validateAiTitle,
  normalizeAiRegistration,
  buildFallbackRegistration,
  buildUsedAttributes,
  isHumanGateRequired,
  normalizeForComparison,
  compactTitle
};
