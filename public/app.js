// APP STATE
let products = [];
let selectedProductIds = new Set();
let currentPage = 1;
const limit = 20;
let totalProducts = 0;
let settings = {
  tinyClientConfigured: false,
  openAiConfigured: false,
  redirectUri: '',
  dictionary: [],
  basePrompt: ''
};
let authStatus = {
  connected: false,
  expired: false
};

// INITIALIZATION
document.addEventListener('DOMContentLoaded', async () => {
  // Check URL parameters (OAuth callback success)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('connected')) {
    showToast('Conectado ao Tiny ERP com sucesso!', 'success');
    // Clear URL query parameters without reloading
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  await loadSettings();
  await checkConnection();

  if (authStatus.connected && !authStatus.expired) {
    loadProducts();
  }
});

// TAB SYSTEM
function switchTab(tabId) {
  // Hide all contents
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  // Deactivate all buttons
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  // Show active tab
  document.getElementById(`tab-${tabId}`).classList.add('active');
  document.getElementById(`tab-${tabId}-btn`).classList.add('active');
}

// NOTIFICATION SYSTEM
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getAiStatusLabel(status) {
  if (status === 'ok') return 'Aprovado';
  if (status === 'blocked') return 'Bloqueado';
  return 'Revisar';
}

function getGenerationSourceLabel(source) {
  if (source === 'ai_fast') return 'IA rápida';
  if (source === 'ai_quality') return 'IA qualidade';
  if (source === 'fallback') return 'Fallback seguro';
  return 'IA';
}

function isMlOptimized(product) {
  return Boolean(product?.mlOtimizado);
}

function renderAiQualityPanel(data) {
  if (!data) return '<div class="ai-quality-panel empty">Aguardando análise da IA.</div>';

  const confidence = Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0;
  const confidenceLabel = `${Math.round(confidence * 100)}%`;
  const statusClass = data.status === 'ok' ? 'ok' : data.status === 'blocked' ? 'blocked' : 'needs-review';
  const problems = Array.isArray(data.problemasDetectados) ? data.problemasDetectados : [];
  const usedAttributes = Array.isArray(data.usedAttributes) ? data.usedAttributes : [];
  const qualityFlags = Array.isArray(data.qualityFlags) ? data.qualityFlags : [];
  const attrs = data.atributosIdentificados || {};
  const attrSummary = [
    attrs.tipoProduto,
    attrs.marca,
    attrs.material,
    attrs.modelo,
    attrs.tamanho,
    attrs.cor,
    attrs.quantidade,
    attrs.compatibilidade,
    attrs.voltagem
  ].filter(Boolean);
  const usedSummary = usedAttributes.length ? usedAttributes : attrSummary;
  const attention = problems.slice(0, 2).join('; ') || qualityFlags.slice(0, 3).join(', ');
  const sourceLabel = getGenerationSourceLabel(data.generationSource);
  const fullDetails = [
    data.motivoHumanGate,
    problems.join('; '),
    data.observacoes
  ].filter(Boolean).join(' | ');

  return `
    <div class="ai-quality-panel ${statusClass}" title="${escapeHtml(fullDetails)}">
      <div class="ai-quality-head">
        <span class="ai-status-pill ${statusClass}">${getAiStatusLabel(data.status)}</span>
        <span class="ai-confidence">Confiança ${confidenceLabel}</span>
        ${data.humanGate ? '<span class="ai-human-gate">Human gate</span>' : ''}
      </div>
      ${usedSummary.length ? `<p class="ai-note"><strong>Usado:</strong> ${escapeHtml(usedSummary.slice(0, 6).join(', '))}</p>` : ''}
      ${attention ? `<p class="ai-note"><strong>Atenção:</strong> ${escapeHtml(attention)}</p>` : ''}
      <p class="ai-note"><strong>Fonte:</strong> ${escapeHtml(sourceLabel)}</p>
    </div>
  `;
}

function setAiQualityPanel(productId, content) {
  const panel = document.getElementById(`ai-quality-${productId}`);
  if (panel) panel.innerHTML = content;
}

// CHECK CONNECTIONS & CREDENTIALS STATUS
async function checkConnection() {
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    authStatus = await res.json();
    
    const tinyBadge = document.getElementById('tiny-status');
    const oauthBtn = document.getElementById('btn-oauth-connect');
    
    if (authStatus.connected) {
      if (authStatus.expired) {
        tinyBadge.className = 'status-badge warning';
        tinyBadge.querySelector('.status-label').innerText = 'Tiny ERP: Expirado';
        oauthBtn.innerText = 'Reconectar Tiny ERP';
      } else {
        tinyBadge.className = 'status-badge connected';
        tinyBadge.querySelector('.status-label').innerText = 'Tiny ERP: Conectado';
        oauthBtn.innerText = 'Tiny ERP Conectado';
      }
    } else {
      tinyBadge.className = 'status-badge disconnected';
      tinyBadge.querySelector('.status-label').innerText = 'Tiny ERP: Desconectado';
      oauthBtn.innerText = 'Conectar ao Tiny ERP (OAuth)';
    }

    // Enable/disable OAuth button based on environment setup
    if (settings.tinyClientConfigured) {
      oauthBtn.disabled = false;
    } else {
      oauthBtn.disabled = true;
    }

    // Update OpenAI Status
    const openAiBadge = document.getElementById('openai-status');
    if (settings.openAiConfigured) {
      openAiBadge.className = 'status-badge connected';
      openAiBadge.querySelector('.status-label').innerText = 'OpenAI: Pronto';
    } else {
      openAiBadge.className = 'status-badge disconnected';
      openAiBadge.querySelector('.status-label').innerText = 'OpenAI: Sem Chave';
    }
  } catch (err) {
    console.error('Erro ao verificar conexão:', err);
  }
}

// FETCH SETTINGS FROM BACKEND
async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    const serverSettings = await res.json();
    const localSettings = loadLocalSettings();
    settings = {
      ...serverSettings,
      dictionary: localSettings.dictionary,
      basePrompt: localSettings.basePrompt
    };

    // Populate Settings Inputs
    document.getElementById('settings-openai-key').value = settings.openAiConfigured ? 'Configurado na Vercel' : '';
    document.getElementById('settings-client-id').value = settings.tinyClientConfigured ? 'Configurado na Vercel' : '';
    document.getElementById('settings-client-secret').value = settings.tinyClientConfigured ? 'Configurado na Vercel' : '';
    document.getElementById('settings-redirect-uri').value = settings.redirectUri;
    document.getElementById('ai-base-prompt').value = settings.basePrompt;

    // Render Dictionary list
    renderDictionary();
    loadOptimizerMemory();
  } catch (err) {
    console.error('Erro ao carregar configurações:', err);
    showToast('Falha ao carregar configurações locais.', 'error');
  }
}

async function loadOptimizerMemory() {
  const summary = document.getElementById('memory-summary');
  const list = document.getElementById('memory-list');
  if (!summary || !list) return;

  summary.innerText = 'Carregando memória...';
  list.innerHTML = '';

  try {
    const res = await fetch('/api/memory?limit=6', { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Falha ao carregar memória');
    }

    const data = await res.json();
    const storageLabel = data.storage?.persistent ? 'persistente' : 'temporária';
    summary.innerText = `${data.total || 0} exemplos aceitos • memória ${storageLabel}`;
    list.innerHTML = Array.isArray(data.examples) && data.examples.length > 0
      ? data.examples.map(example => `
          <div class="memory-item">
            <span class="memory-original">${escapeHtml(example.originalTitle)}</span>
            <span class="memory-arrow">→</span>
            <span class="memory-optimized">${escapeHtml(example.optimizedTitle)}</span>
          </div>
        `).join('')
      : '<div class="memory-empty">Nenhum exemplo salvo ainda.</div>';
  } catch (err) {
    summary.innerText = 'Falha ao carregar memória';
    list.innerHTML = `<div class="memory-empty">${escapeHtml(err.message)}</div>`;
  }
}

async function clearOptimizerMemory() {
  const shouldClear = confirm('Limpar todos os exemplos aceitos da memória da IA?');
  if (!shouldClear) return;

  try {
    const res = await fetch('/api/memory', { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Falha ao limpar memória');
    }

    showToast('Memória da IA limpa.', 'success');
    loadOptimizerMemory();
  } catch (err) {
    showToast(`Erro ao limpar memória: ${err.message}`, 'error');
  }
}

function loadLocalSettings() {
  try {
    return {
      dictionary: JSON.parse(localStorage.getItem('mlOptimizerDictionary') || '[]'),
      basePrompt: localStorage.getItem('mlOptimizerBasePrompt') || ''
    };
  } catch (err) {
    console.error('Erro ao ler configurações locais:', err);
    return { dictionary: [], basePrompt: '' };
  }
}

function saveLocalSettings(partialSettings) {
  if (partialSettings.dictionary !== undefined) {
    localStorage.setItem('mlOptimizerDictionary', JSON.stringify(partialSettings.dictionary));
    settings.dictionary = partialSettings.dictionary;
  }

  if (partialSettings.basePrompt !== undefined) {
    localStorage.setItem('mlOptimizerBasePrompt', partialSettings.basePrompt);
    settings.basePrompt = partialSettings.basePrompt;
  }
}

// SAVE CONNECTIVITY SETTINGS
async function saveSettings(e) {
  e.preventDefault();
  showToast('Credenciais agora são configuradas nas Environment Variables da Vercel.', 'info');
}

// INITIATE OAUTH FLOW WITH TINY ERP
async function startOAuthFlow() {
  try {
    const res = await fetch('/api/auth/url', { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Erro desconhecido');
    }
    const data = await res.json();
    // Redirect user to Tiny ERP authentication
    window.location.href = data.url;
  } catch (err) {
    showToast(`Erro ao iniciar autenticação: ${err.message}`, 'error');
  }
}

// HIGHLIGHT INTERNAL TERMS IN THE TITLE
function highlightInternalTerms(title) {
  if (!settings.dictionary || settings.dictionary.length === 0) return title;
  
  let highlighted = title;
  // Sort from longest term to shortest term to avoid partial replacement issues
  const sortedDict = [...settings.dictionary].sort((a, b) => b.from.length - a.from.length);

  sortedDict.forEach(entry => {
    const term = entry.from.trim();
    if (!term) return;

    // Word boundary regex or general case-insensitive match
    const regex = new RegExp(`\\b(${term})\\b`, 'gi');
    highlighted = highlighted.replace(regex, `<span class="internal-highlight">$1</span>`);
  });

  return highlighted;
}

// LOAD PRODUCTS
async function loadProducts(e) {
  if (e) e.preventDefault();
  
  if (!authStatus.connected) {
    showToast('Por favor, conecte-se ao Tiny ERP na aba "Conectividade" primeiro.', 'warning');
    return;
  }

  const listContainer = document.getElementById('products-list');
  // Render loading skeleton
  listContainer.innerHTML = Array(4).fill(0).map(() => `
    <tr class="skeleton-row">
      <td><div class="skeleton-text short"></div></td>
      <td>
        <div class="skeleton-text short" style="margin-bottom: 0.5rem;"></div>
        <div class="skeleton-text medium"></div>
      </td>
      <td><div class="skeleton-text long"></div></td>
      <td><div class="skeleton-text long"></div></td>
      <td><div class="skeleton-text medium"></div></td>
      <td><div class="skeleton-text short"></div></td>
    </tr>
  `).join('');

  const nome = document.getElementById('filter-nome').value.trim();
  const codigo = document.getElementById('filter-sku').value.trim();
  const situacao = document.getElementById('filter-situacao').value;
  const mlOtimizado = document.getElementById('filter-ml-optimized').value;

  const offset = (currentPage - 1) * limit;
  const queryParams = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
    situacao
  });

  if (nome) queryParams.append('nome', nome);
  if (codigo) queryParams.append('codigo', codigo);
  if (mlOtimizado) queryParams.append('mlOtimizado', mlOtimizado);

  try {
    const res = await fetch(`/api/products?${queryParams.toString()}`, { cache: 'no-store' });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Falha ao buscar produtos');
    }

    const data = await res.json();
    products = data.itens || [];
    totalProducts = data.paginacao?.total || products.length;

    renderProductsList();
  } catch (err) {
    console.error('Erro ao carregar produtos:', err);
    listContainer.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty" style="color: var(--danger)">
          Erro ao carregar produtos: ${err.message}. Verifique a conexão com o Tiny.
        </td>
      </tr>
    `;
  }
}

// RENDER PRODUCTS IN THE TABLE
function renderProductsList() {
  const listContainer = document.getElementById('products-list');
  selectedProductIds.clear();
  document.getElementById('select-all-checkbox').checked = false;
  updateSelectedCount();

  if (products.length === 0) {
    listContainer.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">
          Nenhum produto encontrado com os filtros selecionados.
        </td>
      </tr>
    `;
    updatePaginationControls();
    return;
  }

  listContainer.innerHTML = products.map(item => {
    const preco = item.precos?.preco || 0;
    const hasSKU = item.sku && item.sku.trim() !== '';
    const hasGTIN = item.gtin && item.gtin.trim() !== '';
    const hasPreco = preco > 0;

    const skuBadgeClass = hasSKU ? 'valid' : 'invalid';
    const skuBadgeText = hasSKU ? 'SKU' : 'Sem SKU';

    const gtinBadgeClass = hasGTIN ? 'valid' : 'invalid';
    const gtinBadgeText = hasGTIN ? 'EAN/GTIN' : 'Sem GTIN';

    const precoBadgeClass = hasPreco ? 'valid' : 'invalid';
    const precoBadgeText = hasPreco ? 'Preço' : 'Sem Preço';
    const optimizedBadgeClass = isMlOptimized(item) ? 'valid' : 'warning';
    const optimizedBadgeText = isMlOptimized(item) ? 'ML Otimizado' : 'Não otimizado';

    const highlightedTitle = highlightInternalTerms(item.descricao);
    const initialDescription = item.aiRegistration?.descricaoOtimizada || item.descricaoComplementar || item.seo?.descricao || '';

    return `
      <tr id="product-row-${item.id}">
        <td>
          <input type="checkbox" data-id="${item.id}" onchange="toggleSelectProduct('${item.id}', this)">
        </td>
        <td>
          <div class="product-info-cell">
            <span class="product-sku">${item.sku || 'N/A'}</span>
            <span class="product-price">R$ ${preco.toFixed(2)}</span>
          </div>
        </td>
        <td>
          <div class="erp-title-container">
            ${highlightedTitle}
          </div>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.15rem 0.4rem; margin-top: 0.4rem; border-radius: 4px;" onclick="viewDetails(${item.id})">
            🔎 Detalhes
          </button>
        </td>
        <td>
          <div class="suggested-input-container">
            <span class="suggestion-label">Título ML</span>
            <textarea id="suggested-title-${item.id}" 
                      placeholder="Título sugerido pela IA aparecerá aqui..."
                      oninput="updateCharCounter('${item.id}')"></textarea>
            <div class="char-counter" id="char-counter-${item.id}">0 / 60</div>
            <span class="suggestion-label">Descrição ML</span>
            <textarea id="suggested-description-${item.id}"
                      class="suggested-description"
                      placeholder="Descrição otimizada aparecerá aqui...">${escapeHtml(initialDescription)}</textarea>
            <div id="ai-quality-${item.id}">
              ${renderAiQualityPanel(item.aiRegistration)}
            </div>
          </div>
        </td>
        <td>
          <div class="badges-container">
            <span class="requirement-badge ${skuBadgeClass}">${skuBadgeText}</span>
            <span class="requirement-badge ${gtinBadgeClass}">${gtinBadgeText}</span>
            <span class="requirement-badge ${precoBadgeClass}">${precoBadgeText}</span>
            <span id="optimized-badge-${item.id}" class="requirement-badge ${optimizedBadgeClass}">${optimizedBadgeText}</span>
          </div>
        </td>
        <td>
          <div class="row-actions">
            <button class="btn-secondary btn-row-action" title="Otimizar com IA" onclick="optimizeProduct('${item.id}')">✨</button>
            <button class="btn-success btn-row-action" title="Salvar no Tiny" onclick="saveProduct('${item.id}')">💾</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updatePaginationControls();
}

// UPDATE CHAR COUNTER
function updateCharCounter(productId) {
  const textarea = document.getElementById(`suggested-title-${productId}`);
  const counter = document.getElementById(`char-counter-${productId}`);
  const length = textarea.value.length;

  counter.innerText = `${length} / 60`;

  if (length > 60) {
    counter.classList.add('limit-exceeded');
  } else {
    counter.classList.remove('limit-exceeded');
  }
}

// PAGINATION CONTROLS
function updatePaginationControls() {
  const start = totalProducts === 0 ? 0 : (currentPage - 1) * limit + 1;
  const end = Math.min(currentPage * limit, totalProducts);

  document.getElementById('pag-start').innerText = start;
  document.getElementById('pag-end').innerText = end;
  document.getElementById('pag-total').innerText = totalProducts;
  document.getElementById('current-page').innerText = `Página ${currentPage}`;

  document.getElementById('prev-page-btn').disabled = currentPage <= 1;
  document.getElementById('next-page-btn').disabled = end >= totalProducts;
}

function changePage(direction) {
  currentPage += direction;
  loadProducts();
}

// TOGGLE INDIVIDUAL PRODUCT SELECTION
function toggleSelectProduct(id, checkbox) {
  if (checkbox.checked) {
    selectedProductIds.add(id);
  } else {
    selectedProductIds.delete(id);
  }
  updateSelectedCount();
}

// TOGGLE SELECT ALL
function toggleSelectAll(checkbox) {
  const checkBoxes = document.querySelectorAll('#products-list input[type="checkbox"]');
  checkBoxes.forEach(cb => {
    cb.checked = checkbox.checked;
    const id = cb.getAttribute('data-id');
    if (checkbox.checked) {
      selectedProductIds.add(id);
    } else {
      selectedProductIds.delete(id);
    }
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  document.getElementById('selected-count').innerText = selectedProductIds.size;
}

// OPTIMIZE INDIVIDUAL PRODUCT USING AI
async function optimizeProduct(productId) {
  if (!settings.openAiConfigured) {
    showToast('Chave de API da OpenAI não configurada na Vercel.', 'warning');
    switchTab('settings');
    return;
  }

  const product = products.find(p => p.id == productId);
  if (!product) return;

  const textarea = document.getElementById(`suggested-title-${productId}`);
  const descriptionTextarea = document.getElementById(`suggested-description-${productId}`);
  textarea.value = "Otimizando...";
  textarea.disabled = true;
  if (descriptionTextarea) {
    descriptionTextarea.value = "Criando descrição...";
    descriptionTextarea.disabled = true;
  }
  setAiQualityPanel(productId, '<div class="ai-quality-panel loading">Analisando cadastro...</div>');

  try {
    const res = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: product.descricao,
        sku: product.sku,
        category: product.categoria?.nome || '',
        dictionary: settings.dictionary,
        basePrompt: settings.basePrompt
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Falha ao otimizar');
    }

    const data = await res.json();
    product.aiRegistration = data;
    textarea.value = data.tituloOtimizado || '';
    textarea.disabled = false;
    if (descriptionTextarea) {
      descriptionTextarea.value = data.descricaoOtimizada || '';
      descriptionTextarea.disabled = false;
    }
    updateCharCounter(productId);
    setAiQualityPanel(productId, renderAiQualityPanel(data));

    if (data.status === 'blocked') {
      showToast('IA bloqueou este cadastro para revisão humana.', 'warning');
    } else if (data.humanGate) {
      showToast('Título sugerido com revisão humana recomendada.', 'warning');
    } else {
      showToast(`Cadastro otimizado: "${data.tituloOtimizado}"`, 'success');
    }
  } catch (err) {
    console.error(err);
    textarea.value = "";
    textarea.disabled = false;
    if (descriptionTextarea) {
      descriptionTextarea.value = "";
      descriptionTextarea.disabled = false;
    }
    setAiQualityPanel(productId, '<div class="ai-quality-panel blocked">Falha ao gerar análise da IA.</div>');
    showToast(`Erro na otimização: ${err.message}`, 'error');
  }
}

// SAVE INDIVIDUAL PRODUCT CHANGES TO TINY ERP
async function saveProduct(productId) {
  const suggestedTitleInput = document.getElementById(`suggested-title-${productId}`);
  const suggestedDescriptionInput = document.getElementById(`suggested-description-${productId}`);
  const newTitle = suggestedTitleInput.value.trim();
  const newDescription = suggestedDescriptionInput ? suggestedDescriptionInput.value.trim() : '';

  if (!newTitle || newTitle === "Otimizando...") {
    showToast('Por favor, gere ou digite um título sugerido primeiro.', 'warning');
    return;
  }

  if (newTitle.length > 60) {
    showToast('O título excede o limite de 60 caracteres do Mercado Livre!', 'error');
    return;
  }

  const product = products.find(p => p.id == productId);
  if (product?.aiRegistration?.humanGate) {
    const shouldContinue = confirm('A IA marcou este cadastro para revisão humana. Deseja salvar mesmo assim?');
    if (!shouldContinue) return;
  }

  suggestedTitleInput.disabled = true;
  if (suggestedDescriptionInput) suggestedDescriptionInput.disabled = true;

  try {
    const res = await fetch(`/api/products/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        descricao: newTitle,
        descricaoComplementar: newDescription,
        mlOtimizado: true,
        learning: {
          generationSource: product?.aiRegistration?.generationSource || '',
          status: product?.aiRegistration?.status || '',
          humanGate: Boolean(product?.aiRegistration?.humanGate),
          usedAttributes: product?.aiRegistration?.usedAttributes || []
        },
        seo: {
          titulo: newTitle,
          descricao: newDescription
        }
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro ao salvar no ERP');
    }

    showToast('Produto atualizado com sucesso no Tiny ERP!', 'success');
    // Reload only this product info in local array list if needed
    if (product) {
      product.descricao = newTitle;
      product.descricaoComplementar = newDescription;
      product.mlOtimizado = true;
      loadOptimizerMemory();
      // Refresh display row
      const row = document.getElementById(`product-row-${productId}`);
      row.querySelector('.erp-title-container').innerHTML = highlightInternalTerms(newTitle);
      const optimizedBadge = document.getElementById(`optimized-badge-${productId}`);
      if (optimizedBadge) {
        optimizedBadge.className = 'requirement-badge valid';
        optimizedBadge.innerText = 'ML Otimizado';
      }
    }
  } catch (err) {
    console.error(err);
    showToast(`Erro ao salvar: ${err.message}`, 'error');
  } finally {
    suggestedTitleInput.disabled = false;
    if (suggestedDescriptionInput) suggestedDescriptionInput.disabled = false;
  }
}

// BULK OPTIMIZE SELECTED PRODUCTS
async function bulkOptimize() {
  if (selectedProductIds.size === 0) {
    showToast('Nenhum produto selecionado.', 'warning');
    return;
  }

  showToast(`Otimizando ${selectedProductIds.size} produtos selecionados...`, 'info');

  // Loop through all selected product ids and run optimizations in parallel with slight delay
  const ids = Array.from(selectedProductIds);
  for (const id of ids) {
    // Slight pause to prevent hitting API limits aggressively
    await new Promise(r => setTimeout(r, 200));
    optimizeProduct(id);
  }
}

// BULK SAVE SELECTED PRODUCTS TO TINY ERP
async function bulkSave() {
  if (selectedProductIds.size === 0) {
    showToast('Nenhum produto selecionado.', 'warning');
    return;
  }

  const ids = Array.from(selectedProductIds);
  let savedCount = 0;
  let errorCount = 0;

  showToast(`Salvando alterações no Tiny ERP...`, 'info');

  for (const id of ids) {
    const input = document.getElementById(`suggested-title-${id}`);
    const descriptionInput = document.getElementById(`suggested-description-${id}`);
    const val = input ? input.value.trim() : '';
    const descriptionVal = descriptionInput ? descriptionInput.value.trim() : '';
    const product = products.find(p => p.id == id);
    
    if (val && val !== "Otimizando..." && val.length <= 60) {
      try {
        const res = await fetch(`/api/products/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            descricao: val,
            descricaoComplementar: descriptionVal,
            mlOtimizado: true,
            learning: {
              generationSource: product?.aiRegistration?.generationSource || '',
              status: product?.aiRegistration?.status || '',
              humanGate: Boolean(product?.aiRegistration?.humanGate),
              usedAttributes: product?.aiRegistration?.usedAttributes || []
            },
            seo: {
              titulo: val,
              descricao: descriptionVal
            }
          })
        });

        if (res.ok) {
          savedCount++;
          // Update local product name
          if (product) {
            product.descricao = val;
            product.descricaoComplementar = descriptionVal;
            product.mlOtimizado = true;
            const row = document.getElementById(`product-row-${id}`);
            if (row) {
              row.querySelector('.erp-title-container').innerHTML = highlightInternalTerms(val);
              const optimizedBadge = document.getElementById(`optimized-badge-${id}`);
              if (optimizedBadge) {
                optimizedBadge.className = 'requirement-badge valid';
                optimizedBadge.innerText = 'ML Otimizado';
              }
            }
          }
        } else {
          errorCount++;
        }
      } catch (err) {
        errorCount++;
      }
    }
  }

  if (savedCount > 0) {
    loadOptimizerMemory();
  }

  showToast(`Processamento concluído: ${savedCount} salvos, ${errorCount} erros.`, savedCount > 0 ? 'success' : 'error');
}

// DICTIONARY RENDER
function renderDictionary() {
  const container = document.getElementById('dictionary-list');
  if (!settings.dictionary || settings.dictionary.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; color: var(--text-muted)">
          Nenhuma regra registrada. Cadastre termos acima.
        </td>
      </tr>
    `;
    return;
  }

  container.innerHTML = settings.dictionary.map((entry, index) => `
    <tr>
      <td><span class="product-sku">${entry.from}</span></td>
      <td>${entry.to ? entry.to : '<span style="color: var(--danger)">remover termo</span>'}</td>
      <td>
        <button class="btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="deleteDictionaryEntry(${index})">Deletar</button>
      </td>
    </tr>
  `).join('');
}

// ADD DICTIONARY ENTRY
async function addDictionaryEntry(e) {
  e.preventDefault();
  const fromInput = document.getElementById('term-from');
  const toInput = document.getElementById('term-to');

  const fromVal = fromInput.value.trim().toUpperCase();
  const toVal = toInput.value.trim();

  if (!fromVal) return;

  // Add to settings dictionary
  const newDict = [...settings.dictionary];
  // Prevent duplicates
  const existingIdx = newDict.findIndex(item => item.from === fromVal);
  if (existingIdx !== -1) {
    newDict[existingIdx].to = toVal;
  } else {
    newDict.push({ from: fromVal, to: toVal });
  }

  try {
    saveLocalSettings({ dictionary: newDict });
    showToast('Termo adicionado ao dicionário!', 'success');
    fromInput.value = '';
    toInput.value = '';
    renderDictionary();
    // Reload products list to update visual highlights if already loaded
    if (products.length > 0) {
      renderProductsList();
    }
  } catch (err) {
    console.error(err);
    showToast('Erro ao adicionar regra.', 'error');
  }
}

// DELETE DICTIONARY ENTRY
async function deleteDictionaryEntry(index) {
  const newDict = [...settings.dictionary];
  newDict.splice(index, 1);

  try {
    saveLocalSettings({ dictionary: newDict });
    showToast('Termo removido do dicionário.', 'info');
    renderDictionary();
    if (products.length > 0) {
      renderProductsList();
    }
  } catch (err) {
    console.error(err);
    showToast('Erro ao deletar regra.', 'error');
  }
}

// SAVE CUSTOM PROMPT
async function savePrompt() {
  const promptVal = document.getElementById('ai-base-prompt').value;

  try {
    saveLocalSettings({ basePrompt: promptVal });
    showToast('Prompt base atualizado com sucesso!', 'success');
  } catch (err) {
    console.error(err);
    showToast('Erro ao salvar prompt base.', 'error');
  }
}

// DETAIL DRAWER / MODAL VIEWER
async function viewDetails(productId) {
  const modal = document.getElementById('details-modal');
  const modalBody = document.getElementById('modal-product-body');
  const modalTitle = document.getElementById('modal-product-title');

  modalTitle.innerText = "Carregando detalhes...";
  modalBody.innerHTML = '<div style="text-align: center; padding: 2rem;"><span class="skeleton-text medium" style="margin: 0 auto;"></span></div>';
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`/api/products/${productId}`);
    if (!res.ok) throw new Error('Erro ao obter detalhes do produto');
    
    const details = await res.json();
    
    modalTitle.innerText = details.descricao || "Detalhes do Produto";
    
    const dim = details.dimensoes || {};
    const preco = details.precos || {};
    const seo = details.seo || {};
    const mlStatus = details.mlOtimizado ? 'Já otimizado' : 'Não otimizado';

    modalBody.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item">
          <span class="label">SKU</span>
          <span class="value">${details.sku || 'N/A'}</span>
        </div>
        <div class="detail-item">
          <span class="label">GTIN / EAN</span>
          <span class="value">${details.gtin || 'Não cadastrado'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Preço Unitário</span>
          <span class="value">R$ ${(preco.preco || 0).toFixed(2)}</span>
        </div>
        <div class="detail-item">
          <span class="label">Preço de Custo</span>
          <span class="value">R$ ${(preco.precoCusto || 0).toFixed(2)}</span>
        </div>
        <div class="detail-item">
          <span class="label">Origem</span>
          <span class="value">${details.origem !== undefined ? getOrigemText(details.origem) : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Unidade</span>
          <span class="value">${details.unidade || 'UN'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Otimização ML</span>
          <span class="value">${mlStatus}</span>
        </div>
      </div>

      <h4 style="font-family: var(--font-display); font-size: 0.95rem; font-weight: 600; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.25rem;">
        Dimensões (Mercado Livre exige para cálculo de frete)
      </h4>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="label">Largura</span>
          <span class="value">${dim.largura ? dim.largura + ' cm' : '⚠️ Não cadastrada'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Altura</span>
          <span class="value">${dim.altura ? dim.altura + ' cm' : '⚠️ Não cadastrada'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Comprimento</span>
          <span class="value">${dim.comprimento ? dim.comprimento + ' cm' : '⚠️ Não cadastrado'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Peso Bruto</span>
          <span class="value">${dim.pesoBruto ? dim.pesoBruto + ' kg' : '⚠️ Não cadastrado'}</span>
        </div>
      </div>

      <h4 style="font-family: var(--font-display); font-size: 0.95rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.25rem;">
        SEO & Metadata
      </h4>
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div class="detail-item">
          <span class="label">Título SEO</span>
          <span class="value">${seo.titulo || 'Nenhum título cadastrado'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Descrição Complementar</span>
          <span class="value" style="font-size: 0.85rem; max-height: 100px; overflow-y: auto;">${details.descricaoComplementar || 'Nenhuma descrição complementar cadastrada'}</span>
        </div>
        <div class="detail-item">
          <span class="label">Descrição SEO</span>
          <span class="value" style="font-size: 0.85rem; max-height: 100px; overflow-y: auto;">${seo.descricao || 'Nenhuma descrição cadastrada'}</span>
        </div>
      </div>
    `;

  } catch (err) {
    console.error(err);
    modalTitle.innerText = "Erro";
    modalBody.innerHTML = `<p style="color: var(--danger)">Erro ao carregar detalhes: ${err.message}</p>`;
  }
}

function closeDetailsModal() {
  document.getElementById('details-modal').classList.add('hidden');
}

// ORIGIN HELPER TEXT
function getOrigemText(code) {
  const origens = {
    0: '0 - Nacional',
    1: '1 - Estrangeira - Importação Direta',
    2: '2 - Estrangeira - Adquirida no Mercado Interno',
    3: '3 - Nacional - Conteúdo de Importação > 40%',
    4: '4 - Nacional - Produção Conforme Processo Básico',
    5: '5 - Nacional - Conteúdo de Importação <= 40%',
    6: '6 - Estrangeira - Importação Direta Sem Similar',
    7: '7 - Estrangeira - Adquirida Internamente Sem Similar',
    8: '8 - Nacional - Conteúdo de Importação > 70%'
  };
  return origens[code] || `${code} - Desconhecido`;
}
