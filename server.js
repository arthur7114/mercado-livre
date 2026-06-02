const crypto = require('crypto');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_COOKIE = 'tiny_oauth';
const TOKEN_COOKIE_CHUNKS = `${TOKEN_COOKIE}_chunks`;
const TOKEN_COOKIE_CHUNK_SIZE = 3500;
const TOKEN_COOKIE_MAX_CHUNKS = 8;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TINY_AUTH_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
const TINY_TOKEN_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/callback') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }

  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function getEnvConfig(req) {
  const forwardedProto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const forwardedHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const hostUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}` : '';
  const appBaseUrl = (process.env.APP_BASE_URL || hostUrl).replace(/\/$/, '');
  const redirectUri = (process.env.TINY_REDIRECT_URI || `${appBaseUrl}/callback`).replace(/\/$/, '');

  return {
    tinyClientId: process.env.TINY_CLIENT_ID || '',
    tinyClientSecret: process.env.TINY_CLIENT_SECRET || '',
    openAiApiKey: process.env.OPENAI_API_KEY || '',
    openAiFastModel: process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-nano',
    openAiQualityModel: process.env.OPENAI_QUALITY_MODEL || 'gpt-4.1-mini',
    sessionSecret: process.env.SESSION_SECRET || '',
    appBaseUrl,
    redirectUri
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map(cookie => cookie.trim()).filter(Boolean);
  const cookie = cookies.find(item => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function getTokenCookie(req) {
  const chunkCount = Number.parseInt(getCookie(req, TOKEN_COOKIE_CHUNKS), 10);
  if (Number.isFinite(chunkCount) && chunkCount > 0 && chunkCount <= TOKEN_COOKIE_MAX_CHUNKS) {
    let value = '';
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = getCookie(req, `${TOKEN_COOKIE}.${index}`);
      if (!chunk) return '';
      value += chunk;
    }
    return value;
  }

  return getCookie(req, TOKEN_COOKIE);
}

function getEncryptionKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptTokenPayload(payload, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

function decryptTokenPayload(value, secret) {
  if (!value || !secret) return null;

  try {
    const raw = Buffer.from(value, 'base64url');
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(secret), iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8');

    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Falha ao ler cookie OAuth:', error.message);
    return null;
  }
}

function readTokenSession(req) {
  const config = getEnvConfig(req);
  return decryptTokenPayload(getTokenCookie(req), config.sessionSecret);
}

function writeTokenSession(res, req, session) {
  const config = getEnvConfig(req);
  const secure = config.appBaseUrl.startsWith('https://');
  const encrypted = encryptTokenPayload(session, config.sessionSecret);
  const maxAge = Math.floor(COOKIE_MAX_AGE_MS / 1000);
  const commonParts = [
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`
  ];

  if (secure) {
    commonParts.push('Secure');
  }

  const clearParts = [
    `${TOKEN_COOKIE}=`,
    ...commonParts.filter(part => !part.startsWith('Max-Age=')),
    'Max-Age=0'
  ];
  const cookies = [clearParts.join('; ')];

  const chunks = encrypted.match(new RegExp(`.{1,${TOKEN_COOKIE_CHUNK_SIZE}}`, 'g')) || [];
  cookies.push(`${TOKEN_COOKIE_CHUNKS}=${chunks.length}; ${commonParts.join('; ')}`);

  chunks.forEach((chunk, index) => {
    cookies.push(`${TOKEN_COOKIE}.${index}=${encodeURIComponent(chunk)}; ${commonParts.join('; ')}`);
  });

  for (let index = chunks.length; index < TOKEN_COOKIE_MAX_CHUNKS; index += 1) {
    cookies.push(`${TOKEN_COOKIE}.${index}=; ${commonParts.filter(part => !part.startsWith('Max-Age=')).join('; ')}; Max-Age=0`);
  }

  res.setHeader('Set-Cookie', cookies);
}

function clearTokenSession(res) {
  const cookies = [
    `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${TOKEN_COOKIE_CHUNKS}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  ];

  for (let index = 0; index < TOKEN_COOKIE_MAX_CHUNKS; index += 1) {
    cookies.push(`${TOKEN_COOKIE}.${index}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  res.setHeader('Set-Cookie', cookies);
}

function getPublicSettings(req) {
  const config = getEnvConfig(req);

  return {
    tinyClientConfigured: Boolean(config.tinyClientId && config.tinyClientSecret),
    openAiConfigured: Boolean(config.openAiApiKey),
    redirectUri: config.redirectUri,
    appBaseUrl: config.appBaseUrl,
    dictionary: [],
    basePrompt: ''
  };
}

async function checkAndRefreshToken(req, res) {
  const config = getEnvConfig(req);
  const session = readTokenSession(req);

  if (!config.tinyClientId || !config.tinyClientSecret) {
    throw new Error('Credenciais do Tiny/Olist não configuradas nas variáveis de ambiente.');
  }

  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET não configurado nas variáveis de ambiente.');
  }

  const now = Date.now();
  if (session.accessToken && now < (session.tokenExpiry - 300000)) {
    return session.accessToken;
  }

  if (!session?.refreshToken) {
    throw new Error('Sessão do Tiny ERP sem refresh token. Reconecte na aba Conectividade.');
  }

  console.log('Access token expirado ou prestes a expirar. Renovando token...');
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', config.tinyClientId);
  params.append('client_secret', config.tinyClientSecret);
  params.append('refresh_token', session.refreshToken);

  const response = await fetch(TINY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ao renovar token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const updatedSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    tokenExpiry: Date.now() + (data.expires_in * 1000)
  };

  writeTokenSession(res, req, updatedSession);
  console.log('Token renovado com sucesso.');
  return updatedSession.accessToken;
}

app.get('/api/settings', (req, res) => {
  res.json(getPublicSettings(req));
});

app.post('/api/settings', (req, res) => {
  res.status(405).json({
    error: 'Configurações sensíveis devem ser cadastradas nas Environment Variables da Vercel.'
  });
});

app.get('/api/auth/url', (req, res) => {
  const config = getEnvConfig(req);

  if (!config.tinyClientId || !config.tinyClientSecret || !config.redirectUri) {
    return res.status(400).json({ error: 'Client ID, Client Secret ou Redirect URI do Tiny/Olist não configurados.' });
  }

  if (!config.sessionSecret) {
    return res.status(400).json({ error: 'SESSION_SECRET não configurado nas variáveis de ambiente.' });
  }

  const url = `${TINY_AUTH_URL}?client_id=${encodeURIComponent(config.tinyClientId)}&redirect_uri=${encodeURIComponent(config.redirectUri)}&scope=openid&response_type=code`;
  res.json({ url, redirectUri: config.redirectUri });
});

app.get('/api/auth/status', (req, res) => {
  const session = readTokenSession(req);

  if (!session?.accessToken) {
    return res.json({ connected: false, message: 'Não conectado' });
  }

  const expired = Date.now() >= session.tokenExpiry;
  res.json({
    connected: true,
    expired,
    expiryTime: new Date(session.tokenExpiry).toISOString(),
    hasRefreshToken: Boolean(session.refreshToken)
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearTokenSession(res);
  res.json({ success: true });
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`Erro na autorização do Tiny ERP: ${error}`);
  }

  if (!code) {
    return res.send('Código de autorização não recebido.');
  }

  try {
    const config = getEnvConfig(req);

    if (!config.tinyClientId || !config.tinyClientSecret || !config.sessionSecret) {
      return res.send('Credenciais OAuth ou SESSION_SECRET não configurados na Vercel.');
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', config.tinyClientId);
    params.append('client_secret', config.tinyClientSecret);
    params.append('redirect_uri', config.redirectUri);
    params.append('code', code);

    const response = await fetch(TINY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.send(`Erro ao solicitar token de acesso: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      return res.send('Token de acesso não recebido do Tiny ERP.');
    }

    writeTokenSession(res, req, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiry: Date.now() + (data.expires_in * 1000)
    });

    res.redirect('/index.html?connected=true');
  } catch (err) {
    console.error('Erro no callback OAuth:', err);
    res.send(`Erro no callback OAuth: ${err.message}`);
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const token = await checkAndRefreshToken(req, res);
    const queryParams = new URLSearchParams();

    if (req.query.nome) queryParams.append('nome', req.query.nome);
    if (req.query.codigo) queryParams.append('codigo', req.query.codigo);
    if (req.query.situacao) queryParams.append('situacao', req.query.situacao);
    if (req.query.limit) queryParams.append('limit', req.query.limit);
    if (req.query.offset) queryParams.append('offset', req.query.offset);

    const response = await fetch(`https://api.tiny.com.br/public-api/v3/produtos?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const token = await checkAndRefreshToken(req, res);
    const response = await fetch(`https://api.tiny.com.br/public-api/v3/produtos/${req.params.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const token = await checkAndRefreshToken(req, res);
    const productId = req.params.id;
    const updates = req.body;

    const getResponse = await fetch(`https://api.tiny.com.br/public-api/v3/produtos/${productId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      return res.status(getResponse.status).json({ error: `Erro ao buscar produto antes de salvar: ${errorText}` });
    }

    const currentProduct = await getResponse.json();
    const payload = {
      sku: updates.sku || currentProduct.sku,
      descricao: updates.descricao || currentProduct.descricao,
      descricaoComplementar: currentProduct.descricaoComplementar || '',
      unidade: currentProduct.unidade || 'UN',
      unidadePorCaixa: currentProduct.unidadePorCaixa || '',
      ncm: currentProduct.ncm || '',
      gtin: currentProduct.gtin || '',
      origem: currentProduct.origem !== undefined && currentProduct.origem !== null ? parseInt(currentProduct.origem, 10) : 0,
      observacoes: currentProduct.observacoes || '',
      marca: currentProduct.marca?.id ? { id: currentProduct.marca.id } : undefined,
      categoria: currentProduct.categoria?.id ? { id: currentProduct.categoria.id } : undefined,
      precos: currentProduct.precos ? {
        preco: currentProduct.precos.preco || 0,
        precoPromocional: currentProduct.precos.precoPromocional,
        precoCusto: currentProduct.precos.precoCusto || 0
      } : undefined,
      dimensoes: currentProduct.dimensoes ? {
        embalagem: currentProduct.dimensoes.embalagem?.id ? { id: currentProduct.dimensoes.embalagem.id } : undefined,
        largura: currentProduct.dimensoes.largura || 0,
        altura: currentProduct.dimensoes.altura || 0,
        comprimento: currentProduct.dimensoes.comprimento || 0,
        diametro: currentProduct.dimensoes.diametro || 0,
        pesoLiquido: currentProduct.dimensoes.pesoLiquido || 0,
        pesoBruto: currentProduct.dimensoes.pesoBruto || 0,
        quantidadeVolumes: currentProduct.dimensoes.quantidadeVolumes || 1
      } : undefined,
      seo: {
        titulo: (updates.seo && updates.seo.titulo !== undefined) ? updates.seo.titulo : (currentProduct.seo?.titulo || ''),
        descricao: (updates.seo && updates.seo.descricao !== undefined) ? updates.seo.descricao : (currentProduct.seo?.descricao || ''),
        keywords: currentProduct.seo?.keywords || [],
        linkVideo: currentProduct.seo?.linkVideo || '',
        slug: currentProduct.seo?.slug || ''
      }
    };

    const putResponse = await fetch(`https://api.tiny.com.br/public-api/v3/produtos/${productId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      return res.status(putResponse.status).json({ error: `Erro no Tiny ERP ao atualizar: ${errorText}` });
    }

    if (putResponse.status === 204) {
      return res.json({ success: true, message: 'Produto atualizado com sucesso (No Content)' });
    }

    const data = await putResponse.json();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/optimize', async (req, res) => {
  try {
    const config = getEnvConfig(req);

    if (!config.openAiApiKey) {
      return res.status(400).json({ error: 'Chave de API da OpenAI não configurada nas Environment Variables.' });
    }

    const { title, sku, category, dictionary = [], basePrompt = '' } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'O título do produto é obrigatório.' });
    }

    let dictionaryInstructions = '';
    if (Array.isArray(dictionary) && dictionary.length > 0) {
      dictionaryInstructions = 'Aqui está uma lista de termos internos específicos com seus significados ou ações desejadas:\n';
      dictionary.forEach(entry => {
        if (!entry?.from) return;

        if (entry.to && entry.to.trim() !== '') {
          dictionaryInstructions += `- Substitua o termo "${entry.from}" por "${entry.to}"\n`;
        } else {
          dictionaryInstructions += `- Remova o termo "${entry.from}" completamente (é um código interno)\n`;
        }
      });
    }

    const promptText = [
      basePrompt,
      dictionaryInstructions,
      `Produto: ${title}`,
      `SKU: ${sku || 'Nao informado'}`,
      `Categoria: ${category || 'Nao informada'}`,
      'Crie um titulo comercial claro para Mercado Livre no Brasil.',
      'Limite absoluto: 60 caracteres.',
      'Nao copie o titulo original sem melhorar. Reordene, limpe ruido e remova termos sem valor comercial quando houver oportunidade segura.',
      'Se o melhor titulo possivel for igual ao original, explique em observacoes e marque needs_review.',
      'Retorne diagnostico completo de qualidade, confianca e revisao humana conforme o schema.',
      'Se confidence < 0.70, humanGate deve ser true.'
    ].filter(Boolean).join('\n\n');

    const systemPrompt = [
      'Você é um especialista sênior em cadastro de produtos para Mercado Livre Brasil.',
      '',
      'Sua tarefa é transformar dados brutos de produtos em cadastros comerciais claros, seguros e profissionais.',
      '',
      'Prioridades:',
      '1. Identificar corretamente o produto.',
      '2. Preservar atributos comerciais relevantes.',
      '3. Criar um título objetivo, natural e vendável.',
      '4. Respeitar o limite absoluto de 60 caracteres.',
      '5. Remover ruídos como códigos internos, duplicações e termos operacionais.',
      '6. Não inventar informações ausentes.',
      '7. Sinalizar revisão humana quando o produto não puder ser identificado com segurança.',
      '',
      'Regras:',
      '- Responda exclusivamente em JSON válido conforme o schema solicitado.',
      '- Não escreva comentários fora do JSON.',
      '- Não use markdown.',
      '- Não invente marca, modelo, aplicação, compatibilidade, quantidade, medida, material, cor ou voltagem.',
      '- Não use promessas exageradas.',
      '- Não use termos promocionais sem base nos dados.',
      '- Se o produto for ambíguo, incompleto, genérico ou parecer apenas um código interno, marque humanGate como true.',
      '- Se a confiança for menor que 0.70, humanGate deve ser true.',
      '- O título otimizado deve ter no máximo 60 caracteres.',
      '- Quando algum atributo não for conhecido, retorne string vazia. Nunca retorne null.',
      '- Não mantenha códigos ou referências internas no título comercial quando eles não ajudarem o comprador.',
      '- Se o título original tiver palavras soltas como estilo, novo, cadastro, teste, ml ou termos operacionais sem função comercial, remova-as.',
      '- Se o título otimizado ficar igual ao original, status deve ser needs_review e observacoes deve explicar por que não houve melhoria segura.'
    ].join('\n');

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tituloOtimizado: {
          type: 'string'
        },
        status: {
          type: 'string',
          enum: ['ok', 'needs_review', 'blocked']
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1
        },
        humanGate: {
          type: 'boolean'
        },
        motivoHumanGate: {
          type: 'string'
        },
        problemasDetectados: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        atributosIdentificados: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marca: { type: 'string' },
            tipoProduto: { type: 'string' },
            modelo: { type: 'string' },
            cor: { type: 'string' },
            tamanho: { type: 'string' },
            quantidade: { type: 'string' },
            material: { type: 'string' },
            compatibilidade: { type: 'string' },
            voltagem: { type: 'string' },
            outros: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: [
            'marca',
            'tipoProduto',
            'modelo',
            'cor',
            'tamanho',
            'quantidade',
            'material',
            'compatibilidade',
            'voltagem',
            'outros'
          ]
        },
        termosRemovidos: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        observacoes: {
          type: 'string'
        }
      },
      required: [
        'tituloOtimizado',
        'status',
        'confidence',
        'humanGate',
        'motivoHumanGate',
        'problemasDetectados',
        'atributosIdentificados',
        'termosRemovidos',
        'observacoes'
      ]
    };

    function normalizeString(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    function normalizeStringArray(value) {
      return Array.isArray(value)
        ? value.map(item => normalizeString(item)).filter(Boolean)
        : [];
    }

    function clampConfidence(value) {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return 0;
      return Math.min(1, Math.max(0, numericValue));
    }

    function trimTitleToLimit(value, limit = 60) {
      const normalizedTitle = normalizeString(value).replace(/\s+/g, ' ');
      if (normalizedTitle.length <= limit) return normalizedTitle;

      const sliced = normalizedTitle.slice(0, limit).trim();
      const lastSpace = sliced.lastIndexOf(' ');
      return lastSpace > 35 ? sliced.slice(0, lastSpace).trim() : sliced;
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

    function normalizeOptimization(rawData, model) {
      const atributos = rawData?.atributosIdentificados || {};
      const normalized = {
        tituloOtimizado: normalizeString(rawData?.tituloOtimizado),
        status: ['ok', 'needs_review', 'blocked'].includes(rawData?.status) ? rawData.status : 'needs_review',
        confidence: clampConfidence(rawData?.confidence),
        humanGate: Boolean(rawData?.humanGate),
        motivoHumanGate: normalizeString(rawData?.motivoHumanGate),
        problemasDetectados: normalizeStringArray(rawData?.problemasDetectados),
        atributosIdentificados: {
          marca: normalizeString(atributos.marca),
          tipoProduto: normalizeString(atributos.tipoProduto),
          modelo: normalizeString(atributos.modelo),
          cor: normalizeString(atributos.cor),
          tamanho: normalizeString(atributos.tamanho),
          quantidade: normalizeString(atributos.quantidade),
          material: normalizeString(atributos.material),
          compatibilidade: normalizeString(atributos.compatibilidade),
          voltagem: normalizeString(atributos.voltagem),
          outros: normalizeStringArray(atributos.outros)
        },
        termosRemovidos: normalizeStringArray(rawData?.termosRemovidos),
        observacoes: normalizeString(rawData?.observacoes),
        modelo: model
      };

      if (normalized.tituloOtimizado.length > 60) {
        normalized.tituloOtimizado = trimTitleToLimit(normalized.tituloOtimizado);
        normalized.humanGate = true;
        normalized.problemasDetectados.push('Título retornado acima de 60 caracteres e ajustado pelo servidor.');
      }

      if (normalized.confidence < 0.70) {
        normalized.humanGate = true;
      }

      if (normalized.humanGate && normalized.status !== 'blocked') {
        normalized.status = 'needs_review';
      }

      if (normalized.status === 'ok' && normalized.confidence < 0.70) {
        normalized.status = 'needs_review';
      }

      if (!normalized.tituloOtimizado) {
        normalized.status = 'blocked';
        normalized.humanGate = true;
        normalized.problemasDetectados.push('A IA não gerou um título seguro.');
      }

      if (normalizeForComparison(normalized.tituloOtimizado) === normalizeForComparison(title)) {
        normalized.status = 'needs_review';
        normalized.humanGate = true;
        normalized.problemasDetectados.push('Título otimizado ficou igual ao título original.');
        if (!normalized.observacoes) {
          normalized.observacoes = 'A IA não encontrou uma melhoria segura para o título com os dados disponíveis.';
        }
      }

      if (normalized.status === 'blocked' && !normalized.motivoHumanGate) {
        normalized.motivoHumanGate = 'Produto impossível de identificar com segurança a partir dos dados disponíveis.';
      }

      if (normalized.humanGate && !normalized.motivoHumanGate) {
        normalized.motivoHumanGate = 'Revisão humana recomendada antes de salvar no Tiny.';
      }

      normalized.problemasDetectados = [...new Set(normalized.problemasDetectados)];
      normalized.termosRemovidos = [...new Set(normalized.termosRemovidos)];

      return normalized;
    }

    async function requestOptimization(model) {
      const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openAiApiKey}`
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: promptText
            }
          ],
          max_output_tokens: 900,
          text: {
            format: {
              type: 'json_schema',
              name: 'titulo_otimizado',
              strict: true,
              schema
            }
          }
        })
      });

      if (!openAiResponse.ok) {
        const errorText = await openAiResponse.text();
        throw new Error(`OpenAI ${model}: ${openAiResponse.status} - ${errorText}`);
      }

      const result = await openAiResponse.json();
      const candidateText = result.output_text || result.output
        ?.flatMap(item => item.content || [])
        ?.map(content => content.text || '')
        ?.join('');

      if (!candidateText) {
        throw new Error(`OpenAI ${model}: resposta vazia.`);
      }

      const optimizedData = JSON.parse(candidateText.trim());
      return normalizeOptimization(optimizedData, model);
    }

    const models = [...new Set([config.openAiFastModel, config.openAiQualityModel].filter(Boolean))];
    let lastError;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        const optimization = await requestOptimization(model);
        const unchangedTitle = normalizeForComparison(optimization.tituloOtimizado) === normalizeForComparison(title);
        const hasFallbackModel = index < models.length - 1;

        if (unchangedTitle && hasFallbackModel) {
          throw new Error(`OpenAI ${model}: titulo igual ao original; tentando modelo de qualidade.`);
        }

        return res.json(optimization);
      } catch (error) {
        lastError = error;
        console.warn(error.message);
      }
    }

    throw lastError || new Error('A IA não gerou conteúdo válido.');
  } catch (error) {
    console.error('Erro na otimização:', error);
    res.status(500).json({ error: `Falha na otimização: ${error.message}` });
  }
});

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}
