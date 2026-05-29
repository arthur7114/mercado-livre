const crypto = require('crypto');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_COOKIE = 'tiny_oauth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TINY_AUTH_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
const TINY_TOKEN_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getEnvConfig(req) {
  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const appBaseUrl = (process.env.APP_BASE_URL || hostUrl).replace(/\/$/, '');

  return {
    tinyClientId: process.env.TINY_CLIENT_ID || '',
    tinyClientSecret: process.env.TINY_CLIENT_SECRET || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    appBaseUrl,
    redirectUri: `${appBaseUrl}/callback`
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map(cookie => cookie.trim()).filter(Boolean);
  const cookie = cookies.find(item => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
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
  return decryptTokenPayload(getCookie(req, TOKEN_COOKIE), config.sessionSecret);
}

function writeTokenSession(res, req, session) {
  const config = getEnvConfig(req);
  const secure = config.appBaseUrl.startsWith('https://');
  const encrypted = encryptTokenPayload(session, config.sessionSecret);
  const cookieParts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(encrypted)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`
  ];

  if (secure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearTokenSession(res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function getPublicSettings(req) {
  const config = getEnvConfig(req);

  return {
    tinyClientConfigured: Boolean(config.tinyClientId && config.tinyClientSecret),
    geminiConfigured: Boolean(config.geminiApiKey),
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

  if (!session?.refreshToken) {
    throw new Error('Não conectado ao Tiny ERP. Conecte-se na aba Configurações.');
  }

  const now = Date.now();
  if (session.accessToken && now < (session.tokenExpiry - 300000)) {
    return session.accessToken;
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

    if (!config.geminiApiKey) {
      return res.status(400).json({ error: 'Chave de API do Gemini não configurada nas Environment Variables.' });
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

    const promptText = `
${basePrompt}

${dictionaryInstructions}

Dados do produto a otimizar:
- Título Atual no ERP: "${title}"
- SKU: "${sku || 'Não informado'}"
- Categoria: "${category || 'Não informada'}"

Gere o objeto JSON seguindo estritamente as regras de limite de 60 caracteres.
`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.geminiApiKey}`;
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: promptText
          }]
        }],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      return res.status(geminiResponse.status).json({ error: `Erro na API do Gemini: ${errorText}` });
    }

    const result = await geminiResponse.json();
    const candidateText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!candidateText) {
      throw new Error('A IA não gerou conteúdo.');
    }

    const optimizedData = JSON.parse(candidateText.trim());
    res.json(optimizedData);
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
