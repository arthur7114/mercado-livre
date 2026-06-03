const fs = require('fs/promises');
const path = require('path');

const MAX_MEMORY_RECORDS = 500;
const DEFAULT_MEMORY_LIMIT = 8;
let memoryCache = {
  version: 1,
  updatedAt: '',
  records: []
};

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getStoragePath() {
  if (process.env.OPTIMIZER_MEMORY_FILE) {
    return path.resolve(process.env.OPTIMIZER_MEMORY_FILE);
  }

  if (process.env.VERCEL) {
    return '';
  }

  return path.join(__dirname, '..', '.data', 'optimizer-memory.json');
}

function getStorageInfo() {
  const filePath = getStoragePath();
  return {
    mode: filePath ? 'file' : 'memory',
    persistent: Boolean(filePath),
    path: filePath || '',
    maxRecords: MAX_MEMORY_RECORDS
  };
}

async function readStore() {
  const filePath = getStoragePath();
  if (!filePath) return memoryCache;

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      updatedAt: normalizeString(parsed.updatedAt),
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        version: 1,
        updatedAt: '',
        records: []
      };
    }

    throw error;
  }
}

async function writeStore(store) {
  const normalizedStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: store.records.slice(0, MAX_MEMORY_RECORDS)
  };
  const filePath = getStoragePath();

  if (!filePath) {
    memoryCache = normalizedStore;
    return normalizedStore;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, 'utf8');
  return normalizedStore;
}

function normalizeRecord(record = {}) {
  const optimizedTitle = normalizeString(record.optimizedTitle || record.tituloOtimizado);
  const originalTitle = normalizeString(record.originalTitle || record.tituloOriginal);

  return {
    id: normalizeString(record.id) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: normalizeString(record.createdAt) || new Date().toISOString(),
    productId: normalizeString(record.productId),
    sku: normalizeString(record.sku),
    category: normalizeString(record.category),
    originalTitle,
    optimizedTitle,
    optimizedDescription: normalizeString(record.optimizedDescription || record.descricaoOtimizada),
    source: normalizeString(record.source || record.generationSource),
    status: normalizeString(record.status),
    humanGate: Boolean(record.humanGate),
    usedAttributes: Array.isArray(record.usedAttributes)
      ? record.usedAttributes.map(normalizeString).filter(Boolean).slice(0, 12)
      : []
  };
}

function isUsefulRecord(record) {
  return Boolean(
    record.originalTitle
    && record.optimizedTitle
    && record.originalTitle !== record.optimizedTitle
    && record.optimizedTitle.length <= 60
  );
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = [
      record.productId,
      record.sku,
      record.originalTitle.toLowerCase(),
      record.optimizedTitle.toLowerCase()
    ].join('|');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function addOptimizationMemory(record) {
  const normalizedRecord = normalizeRecord(record);
  if (!isUsefulRecord(normalizedRecord)) {
    return {
      saved: false,
      reason: 'Registro sem diferença útil entre título original e título aceito.'
    };
  }

  const store = await readStore();
  const records = dedupeRecords([normalizedRecord, ...store.records.map(normalizeRecord)]);
  const updatedStore = await writeStore({
    ...store,
    records
  });

  return {
    saved: true,
    total: updatedStore.records.length,
    storage: getStorageInfo()
  };
}

async function getMemorySnapshot(options = {}) {
  const limit = Number.isFinite(Number(options.limit))
    ? Number(options.limit)
    : DEFAULT_MEMORY_LIMIT;
  const store = await readStore();
  const records = store.records
    .map(normalizeRecord)
    .filter(isUsefulRecord);

  return {
    storage: getStorageInfo(),
    total: records.length,
    updatedAt: store.updatedAt || '',
    examples: records.slice(0, Math.max(0, limit))
  };
}

function buildMemoryPrompt(snapshot) {
  const examples = Array.isArray(snapshot?.examples) ? snapshot.examples : [];
  if (examples.length === 0) return '';

  return examples.map(example => {
    const parts = [
      `Original: ${example.originalTitle}`,
      `Aceito: ${example.optimizedTitle}`
    ];

    if (example.optimizedDescription) {
      parts.push(`Descricao aceita: ${example.optimizedDescription}`);
    }

    if (example.usedAttributes.length > 0) {
      parts.push(`Atributos usados: ${example.usedAttributes.join(', ')}`);
    }

    return parts.join(' | ');
  }).join('\n');
}

async function clearOptimizationMemory() {
  const updatedStore = await writeStore({
    version: 1,
    records: []
  });

  return {
    cleared: true,
    storage: getStorageInfo(),
    total: updatedStore.records.length
  };
}

module.exports = {
  addOptimizationMemory,
  getMemorySnapshot,
  buildMemoryPrompt,
  clearOptimizationMemory,
  getStorageInfo
};
