/**
 * GroupResume Companion — Dashboard Frontend
 */

// ============================================
// State
// ============================================

const state = {
  status: "disconnected",
  groups: [],
  selectedGroup: null,
  selectedPeriod: "today",
  selectedLevel: 3,
  selectedPrivacy: "smart",
  summary: null,
  contacts: [],
  allContacts: null,
  selectedAI: "groq",
  uploadId: null,
  uploadDates: [],
  uploadSelectedDate: null,
  uploadLevel: 3,
  uploadPrivacy: "with-names",
  uploadAI: "groq",
  uploadInfo: null,
  groupMessages: [],
  msgDateFrom: null,
  msgDateTo: null,
};

// ============================================
// DOM Helpers
// ============================================

const $ = (id) => document.getElementById(id);

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
}

// ============================================
// Loading & Progress System
// ============================================

let progressPollInterval = null;
let loadingTimer = null;
let loadingStartTime = 0;
let activeJobId = null;

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return min > 0 ? `${min}m ${s}s` : `${s}s`;
}

function showLoading(text = "Processando...") {
  $("loading-text").textContent = text;
  $("loading").classList.remove("hidden");
  $("progress-details").classList.add("hidden");
  loadingStartTime = Date.now();
  clearInterval(loadingTimer);
  loadingTimer = setInterval(updateLoadingTimer, 1000);
}

function showLoadingWithProgress(text = "Processando...") {
  $("loading-text").textContent = text;
  $("loading").classList.remove("hidden");
  $("progress-details").classList.remove("hidden");
  $("progress-fill").style.width = "5%";
  $("progress-phase").textContent = "🔄 Iniciando...";
  $("progress-step").textContent = "";
  $("progress-timer").textContent = "⏱️ 0s";
  loadingStartTime = Date.now();
  clearInterval(loadingTimer);
  loadingTimer = setInterval(updateLoadingTimer, 1000);
}

function hideLoading() {
  $("loading").classList.add("hidden");
  clearInterval(loadingTimer);
  stopProgressPolling();
  activeJobId = null;
}

function updateLoadingTimer() {
  const elapsed = Date.now() - loadingStartTime;
  $("progress-timer").textContent = `⏱️ ${formatTime(elapsed)}`;
}

function startProgressPolling(jobId) {
  stopProgressPolling();
  activeJobId = jobId;

  progressPollInterval = setInterval(async () => {
    if (!activeJobId) return;
    try {
      const res = await fetch(`/api/progress/${activeJobId}`);
      if (!res.ok) return;
      const data = await res.json();

      const phaseLabels = {
        starting: "🔄 Iniciando...",
        fetching: "📥 Buscando mensagens do WhatsApp...",
        chunking: "📦 Dividindo em partes...",
        summarizing: "🤖 IA processando...",
        merging: "🔗 Combinando resumos parciais...",
        done: "✅ Concluído!",
        error: "❌ Erro",
      };

      // Phase text with chunk detail
      let phaseText = phaseLabels[data.phase] || data.message;
      if (data.phase === "summarizing" && data.total > 1) {
        phaseText = `🤖 Processando parte ${data.current} de ${data.total}`;
      }
      $("progress-phase").textContent = phaseText;

      // Progress bar
      if (data.total > 1 && data.phase === "summarizing") {
        const percent = Math.min(Math.round(((data.current - 1) / data.total) * 100), 95);
        $("progress-fill").style.width = percent + "%";
      } else if (data.phase === "merging") {
        $("progress-fill").style.width = "90%";
      } else if (data.phase === "done") {
        $("progress-fill").style.width = "100%";
      } else {
        const pulse = 10 + Math.abs(Math.sin(Date.now() / 2000) * 25);
        $("progress-fill").style.width = pulse + "%";
      }

      // Step info with timing details
      let stepParts = [];
      if (data.totalMessages > 0) stepParts.push(`${data.totalMessages} msgs`);
      if (data.provider) stepParts.push(data.provider);
      if (data.avgChunkMs > 0 && data.estimatedRemainingMs > 0 && data.phase === "summarizing") {
        stepParts.push(`~${formatTime(data.estimatedRemainingMs)} restante`);
      }
      if (data.avgChunkMs > 0) {
        stepParts.push(`~${formatTime(data.avgChunkMs)}/parte`);
      }
      $("progress-step").textContent = stepParts.join(" · ");

      // If done, fetch result
      if (data.phase === "done" && data.hasResult) {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        const resultRes = await fetch(`/api/progress/${activeJobId}/result`);
        if (resultRes.ok) {
          const result = await resultRes.json();
          state.summary = result;

          if (!state.selectedGroup) {
            state.selectedGroup = { name: "Arquivo importado" };
          }

          renderResult(result);
          showScreen("screen-result");
          hideLoading();
        }
      }

      // If error, show toast
      if (data.phase === "error") {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        showToast(data.message || "Erro ao gerar resumo", "error");
        hideLoading();
      }
    } catch {
      // Ignore polling errors
    }
  }, 2000);
}

function stopProgressPolling() {
  if (progressPollInterval) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
}

function showToast(message, type = "info") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 4000);
}

function updateStatusBadge(status) {
  const badge = $("status-badge");
  const labels = {
    disconnected: "Desconectado",
    qr: "Aguardando QR",
    connecting: "Conectando...",
    connected: "Conectado",
  };
  const classes = {
    disconnected: "badge-disconnected",
    qr: "badge-qr",
    connecting: "badge-connecting",
    connected: "badge-connected",
  };
  badge.textContent = labels[status] || status;
  badge.className = `badge ${classes[status] || "badge-disconnected"}`;
}

// ============================================
// API Calls
// ============================================

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// ============================================
// Status Polling
// ============================================

let statusPollInterval = null;

async function pollStatus() {
  try {
    const data = await api("/status");
    state.status = data.status;
    updateStatusBadge(data.status);

    if (data.status === "qr") {
      showScreen("screen-qr");
      await loadQrCode();
    } else if (data.status === "connected" || data.status === "connecting") {
      if (document.querySelector("#screen-qr.active")) {
        await loadGroups();
      }
    }
  } catch {
    // Ignore
  }
}

function startStatusPolling() {
  pollStatus();
  statusPollInterval = setInterval(pollStatus, 3000);
}

// ============================================
// QR Code
// ============================================

async function loadQrCode() {
  try {
    const data = await api("/qr");
    if (data.status === "connected") {
      await loadGroups();
      return;
    }
    if (data.qrCode) {
      $("qr-image").innerHTML = `<img src="${data.qrCode}" alt="QR Code" />`;
    }
  } catch {
    $("qr-image").innerHTML = `<p>Aguardando QR code...</p>`;
  }
}

// ============================================
// Groups
// ============================================

async function loadGroups() {
  showScreen("screen-groups");
  try {
    const data = await api("/groups");
    state.groups = data.groups;
    renderGroups();
  } catch (err) {
    $("groups-list").innerHTML = `<div class="loading-placeholder">Erro: ${err.message}</div>`;
  }
}

function renderGroups(filterQuery = "") {
  const list = $("groups-list");
  if (state.groups.length === 0) {
    list.innerHTML = `<div class="loading-placeholder">Nenhum grupo encontrado</div>`;
    $("groups-summary").innerHTML = "";
    return;
  }

  const query = filterQuery.toLowerCase();

  // Organize: communities (with children) then standalone groups
  const communities = state.groups.filter((g) => g.chatType === "community");
  const communityChildren = state.groups.filter((g) =>
    g.chatType === "community-group" || g.chatType === "announcement"
  );
  const standaloneGroups = state.groups.filter((g) =>
    g.chatType === "group" || !g.chatType
  );

  // Summary chips
  $("groups-summary").innerHTML = `
    <span class="summary-chip">🏘️ ${communities.length} comunidade${communities.length !== 1 ? "s" : ""}</span>
    <span class="summary-chip">👥 ${standaloneGroups.length} grupo${standaloneGroups.length !== 1 ? "s" : ""}</span>
    <span class="summary-chip">📊 ${state.groups.length} total</span>
  `;

  let html = "";

  // Communities first
  if (communities.length > 0) {
    for (const comm of communities) {
      const children = communityChildren.filter((c) => c.parentId === comm.id);
      const announcements = children.filter((c) => c.chatType === "announcement");
      const subGroups = children.filter((c) => c.chatType === "community-group");

      // Filter: show community if its name or any child matches
      const commMatches = !query || comm.name.toLowerCase().includes(query);
      const childrenMatch = children.some((c) => c.name.toLowerCase().includes(query));
      if (query && !commMatches && !childrenMatch) continue;

      html += `
        <div class="community-section">
          <div class="community-header" data-community-id="${comm.id}">
            <span class="community-icon">🏘️</span>
            <div class="community-info">
              <h3>${escapeHtml(comm.name)}</h3>
              <p>${comm.participantCount || "?"} membros · ${children.length} grupo${children.length !== 1 ? "s" : ""}</p>
            </div>
            <span class="community-toggle">▼</span>
          </div>
          <div class="community-children" id="community-${comm.id}">
      `;

      for (const ch of announcements) {
        if (query && !ch.name.toLowerCase().includes(query) && !commMatches) continue;
        html += `
          <div class="group-card sub-group announcement" data-id="${ch.id}">
            <span class="sub-icon">📢</span>
            <div class="group-info">
              <h3>${escapeHtml(ch.name)}</h3>
              <p>Canal de avisos</p>
            </div>
            <span class="group-arrow">›</span>
          </div>
        `;
      }

      for (const sg of subGroups) {
        if (query && !sg.name.toLowerCase().includes(query) && !commMatches) continue;
        html += `
          <div class="group-card sub-group" data-id="${sg.id}">
            <span class="sub-icon">💬</span>
            <div class="group-info">
              <h3>${escapeHtml(sg.name)}</h3>
              <p>${sg.participantCount || "?"} participantes</p>
            </div>
            <span class="group-arrow">›</span>
          </div>
        `;
      }

      html += `</div></div>`;
    }
  }

  // Standalone groups
  const filteredStandalone = query
    ? standaloneGroups.filter((g) => g.name.toLowerCase().includes(query))
    : standaloneGroups;

  if (filteredStandalone.length > 0) {
    if (communities.length > 0) {
      html += `<div class="contact-section-label">👥 Grupos Avulsos (${filteredStandalone.length})</div>`;
    }
    for (const g of filteredStandalone) {
      html += `
        <div class="group-card" data-id="${g.id}">
          <span class="group-emoji">👥</span>
          <div class="group-info">
            <h3>${escapeHtml(g.name)}</h3>
            <p>${g.participantCount || "?"} participantes</p>
          </div>
          <span class="group-arrow">›</span>
        </div>
      `;
    }
  }

  if (!html) {
    html = `<div class="loading-placeholder">Nenhum grupo encontrado para "${escapeHtml(filterQuery)}"</div>`;
  }

  list.innerHTML = html;

  // Group card click handlers
  list.querySelectorAll(".group-card").forEach((card) => {
    card.addEventListener("click", () => selectGroup(card.dataset.id));
  });

  // Community toggle handlers
  list.querySelectorAll(".community-header").forEach((header) => {
    header.addEventListener("click", () => {
      const commId = header.dataset.communityId;
      const children = $(`community-${commId}`);
      const toggle = header.querySelector(".community-toggle");
      if (children) {
        children.classList.toggle("collapsed");
        if (toggle) toggle.textContent = children.classList.contains("collapsed") ? "▶" : "▼";
      }
    });
  });
}

function setupGroupSearch() {
  $("group-search").addEventListener("input", (e) => {
    renderGroups(e.target.value);
  });
}

function selectGroup(groupId) {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return;
  state.selectedGroup = group;
  state.selectedPeriod = "today";
  $("messages-group-name").textContent = group.name;
  showScreen("screen-messages");
  setupMessageDateButtons();
  loadGroupMessages();
}

// ============================================
// Messages Preview Screen
// ============================================

function setupMessageDateButtons() {
  const container = $("msg-date-buttons");

  // Reset active state
  container.querySelectorAll(".date-btn").forEach((b) => b.classList.remove("active"));
  const todayBtn = container.querySelector('[data-period="today"]');
  if (todayBtn) todayBtn.classList.add("active");
  $("msg-custom-date").classList.add("hidden");

  container.onclick = (e) => {
    const btn = e.target.closest(".date-btn");
    if (!btn) return;
    container.querySelectorAll(".date-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.selectedPeriod = btn.dataset.period;

    const customDate = $("msg-custom-date");
    customDate.classList.toggle("hidden", btn.dataset.period !== "custom");

    if (btn.dataset.period !== "custom") {
      loadGroupMessages();
    }
  };

  const applyBtn = $("msg-date-apply");
  if (applyBtn) {
    applyBtn.onclick = () => loadGroupMessages();
  }
}

function getDateRange() {
  const today = new Date();
  // Use local time (not UTC) to match server-side date formatting
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  switch (state.selectedPeriod) {
    case "today": return { dateFrom: fmt(today), dateTo: fmt(today) };
    case "yesterday": { const y = new Date(today); y.setDate(y.getDate() - 1); return { dateFrom: fmt(y), dateTo: fmt(y) }; }
    case "3days": { const d = new Date(today); d.setDate(d.getDate() - 2); return { dateFrom: fmt(d), dateTo: fmt(today) }; }
    case "7days": { const d = new Date(today); d.setDate(d.getDate() - 6); return { dateFrom: fmt(d), dateTo: fmt(today) }; }
    case "custom": return {
      dateFrom: $("msg-date-from").value || fmt(today),
      dateTo: $("msg-date-to").value || fmt(today),
    };
    default: return { dateFrom: fmt(today), dateTo: fmt(today) };
  }
}

async function loadGroupMessages() {
  if (!state.selectedGroup) return;

  const list = $("messages-list");
  list.innerHTML = `<div class="loading-placeholder"><div class="spinner"></div>Carregando mensagens...</div>`;
  $("btn-go-summarize").disabled = true;

  const { dateFrom, dateTo } = getDateRange();
  state.msgDateFrom = dateFrom;
  state.msgDateTo = dateTo;

  try {
    const data = await api(`/groups/${encodeURIComponent(state.selectedGroup.id)}/messages?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=1000`);
    state.groupMessages = data.messages || [];
    renderMessages(state.groupMessages);

    const participants = new Set(state.groupMessages.map((m) => m.senderName));
    $("msg-count").textContent = `💬 ${state.groupMessages.length} mensagens`;
    $("msg-participants").textContent = `👥 ${participants.size} participantes`;

    $("btn-go-summarize").disabled = state.groupMessages.length === 0;
  } catch (err) {
    list.innerHTML = `<div class="loading-placeholder">❌ Erro: ${err.message}</div>`;
    $("msg-count").textContent = "💬 0 mensagens";
    $("msg-participants").textContent = "👥 0 participantes";
  }
}

function renderMessages(messages) {
  const list = $("messages-list");

  if (!messages || messages.length === 0) {
    list.innerHTML = `<div class="loading-placeholder">Nenhuma mensagem encontrada para este período</div>`;
    return;
  }

  let html = "";
  let lastDate = "";

  for (const msg of messages) {
    // Date header when day changes
    if (msg.date !== lastDate) {
      lastDate = msg.date;
      const [y, m, d] = msg.date.split("-");
      html += `<div class="msg-date-header">📅 ${d}/${m}/${y}</div>`;
    }

    const isMe = msg.isFromMe ? " msg-from-me" : "";
    const body = msg.isMedia
      ? `<span class="msg-media">${escapeHtml(msg.content || "[mídia]")}</span>`
      : `<span class="msg-body">${escapeHtml(msg.content)}</span>`;

    html += `
      <div class="msg-item${isMe}">
        <span class="msg-time">${msg.time}</span>
        <span class="msg-sender">${escapeHtml(msg.senderName)}:</span>
        ${body}
      </div>
    `;
  }

  list.innerHTML = html;

  // Scroll to bottom to show most recent messages
  list.scrollTop = list.scrollHeight;
}

function goToSummarizeOptions() {
  if (!state.selectedGroup) return;
  $("selected-group-name").textContent = state.selectedGroup.name;

  // Show period info
  const { dateFrom, dateTo } = getDateRange();
  const participants = new Set(state.groupMessages.map((m) => m.senderName));
  const periodText = dateFrom === dateTo
    ? formatDateBR(dateFrom)
    : `${formatDateBR(dateFrom)} a ${formatDateBR(dateTo)}`;
  $("options-period-info").textContent = `📅 ${periodText} · 💬 ${state.groupMessages.length} msgs · 👥 ${participants.size} participantes`;

  // Update Ollama ETA based on message count
  const etaEl = $("options-ollama-eta");
  if (etaEl) {
    etaEl.textContent = `Local · ${estimateOllamaTime(state.groupMessages.length)}`;
  }

  showScreen("screen-options");
}

// ============================================
// Summary Options
// ============================================

function setupOptionButtons() {
  document.querySelectorAll("#screen-options .level-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll("#screen-options .level-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.selectedLevel = parseInt(card.dataset.level);
    });
  });

  document.querySelectorAll("#screen-options .privacy-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll("#screen-options .privacy-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.selectedPrivacy = card.dataset.privacy;
    });
  });

  document.querySelectorAll("#screen-options .ai-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll("#screen-options .ai-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.selectedAI = card.dataset.ai;
    });
  });
}

// ============================================
// Generate Summary (async job + polling)
// ============================================

async function generateSummary() {
  if (!state.selectedGroup) return;

  const dateFrom = state.msgDateFrom || getDateRange().dateFrom;
  const dateTo = state.msgDateTo || getDateRange().dateTo;
  const providerLabel = state.selectedAI === "ollama" ? "🖥️ Ollama Local" : "☁️ Groq Online";

  showLoadingWithProgress(`${providerLabel} — Iniciando...`);

  try {
    const forceNew = $("chk-force-new")?.checked || false;
    const { jobId } = await api("/summarize", {
      method: "POST",
      body: JSON.stringify({
        groupId: state.selectedGroup.id,
        dateFrom,
        dateTo,
        level: state.selectedLevel,
        privacy: state.selectedPrivacy,
        aiProvider: state.selectedAI,
        forceNew,
      }),
    });

    // Reset force-new checkbox after use
    if ($("chk-force-new")) $("chk-force-new").checked = false;

    startProgressPolling(jobId);
  } catch (err) {
    showToast(err.message, "error");
    hideLoading();
  }
}

function renderResult(data) {
  const { summary, stats } = data;
  const groupName = state.selectedGroup?.name || "Arquivo importado";
  const source = stats.source === "upload" ? " 📁" : "";
  const fromCache = data.fromCache || false;

  let infoText = `${groupName} — ${formatDateBR(stats.dateFrom)} ${stats.dateFrom !== stats.dateTo ? "a " + formatDateBR(stats.dateTo) : ""}${source}`;

  if (fromCache && data.cachedAt) {
    const cachedTime = new Date(data.cachedAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    infoText += ` · 📦 Da memória (${cachedTime})`;
  } else if (data.incremental) {
    infoText += ` · 🔄 Incremental (${data.cachedMessages} cache + ${data.newMessages} novas)`;
  }

  $("result-info").textContent = infoText;
  $("summary-content").innerHTML = renderMarkdown(summary);

  let statsHtml = `
    <span>💬 ${stats.totalMessages} mensagens</span>
    <span>👥 ${stats.participants} participantes</span>
  `;

  if (fromCache) {
    statsHtml += `<span>📦 Da memória</span>`;
    statsHtml += `<span>🤖 ${stats.provider}</span>`;
  } else if (data.incremental) {
    statsHtml += `<span>⚡ ${(stats.processingTime / 1000).toFixed(1)}s</span>`;
    statsHtml += `<span>🔄 ${data.cachedMessages} cache + ${data.newMessages} novas</span>`;
    statsHtml += `<span>🤖 ${stats.provider}</span>`;
  } else {
    statsHtml += `<span>⚡ ${(stats.processingTime / 1000).toFixed(1)}s</span>`;
    statsHtml += `<span>📦 ${stats.chunks} parte(s)</span>`;
    statsHtml += `<span>🤖 ${stats.provider}</span>`;
  }

  $("result-stats").innerHTML = statsHtml;
}

// ============================================
// Send to WhatsApp
// ============================================

async function openSendScreen() {
  showScreen("screen-send");
  showLoading("Carregando contatos recentes...");
  try {
    const data = await api("/groups/list/contacts");
    state.contacts = data.contacts;
    state.allContacts = null;
    renderContacts(data.contacts);

    $("tab-recent").classList.add("active");
    $("tab-all").classList.remove("active");

    $("tab-recent").onclick = () => {
      $("tab-recent").classList.add("active");
      $("tab-all").classList.remove("active");
      renderContacts(state.contacts);
    };

    $("tab-all").onclick = async () => {
      $("tab-all").classList.add("active");
      $("tab-recent").classList.remove("active");

      if (!state.allContacts) {
        showLoading("Carregando todos os contatos...");
        try {
          const allData = await api("/groups/list/contacts?all=true");
          state.allContacts = allData.contacts;
        } catch (err) {
          showToast("Erro: " + err.message, "error");
          hideLoading();
          return;
        }
        hideLoading();
      }
      renderContacts(state.allContacts);
    };
  } catch (err) {
    showToast("Erro ao carregar contatos: " + err.message, "error");
    showScreen("screen-result");
  } finally {
    hideLoading();
  }
}

function renderContacts(contacts) {
  const list = $("contacts-list");

  const typeConfig = {
    group: { icon: "👥", label: "Grupos" },
    community: { icon: "🏘️", label: "Comunidades" },
    "community-group": { icon: "💬", label: "Grupos da Comunidade" },
    announcement: { icon: "📢", label: "Canais de Aviso" },
    channel: { icon: "📡", label: "Canais" },
    contact: { icon: "👤", label: "Contatos" },
  };

  // Group by chatType, keeping order by timestamp within each group
  const sections = {};
  const sectionOrder = ["group", "community", "community-group", "announcement", "channel", "contact"];

  for (const c of contacts) {
    const type = c.chatType || (c.isGroup ? "group" : "contact");
    if (!sections[type]) sections[type] = [];
    sections[type].push(c);
  }

  let html = "";

  for (const type of sectionOrder) {
    const items = sections[type];
    if (!items || items.length === 0) continue;

    const cfg = typeConfig[type] || { icon: "📌", label: type };
    html += `<div class="contact-section-label">${cfg.icon} ${cfg.label} (${items.length})</div>`;

    html += items
      .map((c) => {
        const numberDisplay = c.number ? `<span class="contact-number">${formatPhoneNumber(c.number)}</span>` : "";
        return `
        <div class="contact-item" data-id="${c.id}">
          <span class="contact-icon">${cfg.icon}</span>
          <div class="contact-info">
            <span class="contact-name">${escapeHtml(c.name)}</span>
            ${numberDisplay}
          </div>
        </div>
      `;
      })
      .join("");
  }

  if (!html) {
    html = `<div class="loading-placeholder">Nenhum contato encontrado</div>`;
  }

  list.innerHTML = html;

  list.querySelectorAll(".contact-item").forEach((item) => {
    item.addEventListener("click", () => sendToContact(item.dataset.id));
  });
}

function formatPhoneNumber(num) {
  if (!num || num.length < 8) return num;
  // Format BR numbers: +55 (11) 99999-9999
  if (num.startsWith("55") && num.length >= 12) {
    const ddd = num.substring(2, 4);
    const rest = num.substring(4);
    if (rest.length === 9) {
      return `+55 (${ddd}) ${rest.substring(0, 5)}-${rest.substring(5)}`;
    }
    return `+55 (${ddd}) ${rest}`;
  }
  return `+${num}`;
}

async function sendToContact(contactId) {
  if (!state.summary) return;
  showLoading("Enviando resumo...");
  try {
    const formatted = toWhatsAppFormat(
      state.summary.summary,
      state.selectedGroup?.name,
      state.summary.stats
    );
    await api("/send", {
      method: "POST",
      body: JSON.stringify({
        to: contactId,
        message: formatted,
        groupName: state.selectedGroup?.name,
        date: state.summary.stats?.dateFrom,
      }),
    });
    showToast("✅ Resumo enviado!", "success");
    showScreen("screen-result");
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  } finally {
    hideLoading();
  }
}

// ============================================
// Helpers
// ============================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDateBR(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function renderMarkdown(text) {
  return text
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[•·] (.+)$/gm, '<li>$1</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\n/g, '<br>');
}

/**
 * Convert markdown summary to WhatsApp-formatted text.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
 */
function toWhatsAppFormat(summary, groupName, stats) {
  let text = "";

  // Header
  text += `📋 *Resumo — ${groupName || "Grupo"}*\n`;
  if (stats) {
    const dateInfo = stats.dateFrom === stats.dateTo
      ? formatDateBR(stats.dateFrom)
      : `${formatDateBR(stats.dateFrom)} a ${formatDateBR(stats.dateTo)}`;
    text += `📅 ${dateInfo}\n`;
    text += `💬 ${stats.totalMessages} msgs · 👥 ${stats.participants} participantes\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━\n\n`;

  // Strip any AI-generated title/header lines that duplicate the group name
  let content = summary.trim();
  const groupNameLower = (groupName || "").toLowerCase();

  // Remove leading lines that look like titles (contain the group name or start with "Resumo")
  const lines = content.split("\n");
  while (lines.length > 0) {
    const firstLine = lines[0].trim().toLowerCase();
    const isTitle = (
      firstLine.startsWith("##") ||
      firstLine.startsWith("**resumo") ||
      firstLine.startsWith("resumo") ||
      (groupNameLower && firstLine.includes(groupNameLower)) ||
      firstLine.match(/^#+\s/) ||
      firstLine === ""
    );
    if (isTitle) {
      lines.shift();
    } else {
      break;
    }
  }
  content = lines.join("\n").trim();

  // Convert markdown to WhatsApp format
  content = content
    // Headers → WhatsApp bold
    .replace(/^#{1,3} (.+)$/gm, '*$1*')
    // Bold markdown → WhatsApp bold
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Bullet points → WhatsApp-friendly
    .replace(/^- (.+)$/gm, '• $1')
    // Clean up excess whitespace
    .replace(/\n{3,}/g, '\n\n');

  text += content;

  // Footer
  text += `\n\n━━━━━━━━━━━━━━━━━━`;
  text += `\n_Gerado por GroupResume By Julio Corcini_`;

  return text;
}

// ============================================
// File Upload (async job + polling)
// ============================================

async function handleFileUpload(file) {
  if (!file || !file.name.endsWith(".txt")) {
    showToast("Selecione um arquivo .txt exportado do WhatsApp", "error");
    return;
  }

  showLoading("Lendo e analisando arquivo...");
  try {
    const content = await file.text();
    const data = await api("/upload", {
      method: "POST",
      body: JSON.stringify({ content }),
    });

    state.uploadId = data.id;
    state.uploadDates = data.dates;
    state.uploadInfo = data;
    state.uploadSelectedDate = data.dates[0]?.date || null;

    renderUploadScreen(data);
    showScreen("screen-upload");
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  } finally {
    hideLoading();
  }
}

function estimateOllamaTime(msgCount) {
  // Based on benchmarks: gemma3:4b ≈ 2.5s per message
  const secsPerMsg = 2.5;
  const totalSecs = Math.ceil(msgCount * secsPerMsg);
  const min = Math.floor(totalSecs / 60);
  const sec = totalSecs % 60;
  if (min > 0) return `~${min}m ${sec}s`;
  return `~${sec}s`;
}

function estimateGroqTime(msgCount) {
  // Groq online: ~0.3s per message
  const secsPerMsg = 0.3;
  const totalSecs = Math.ceil(msgCount * secsPerMsg);
  if (totalSecs < 60) return `~${totalSecs}s`;
  return `~${Math.ceil(totalSecs / 60)}m`;
}

function renderUploadScreen(data) {
  // Update ETA on AI cards
  const etaEl = $("upload-ollama-eta");
  if (etaEl && data.dates && state.uploadSelectedDate) {
    const dateInfo = data.dates.find((d) => d.date === state.uploadSelectedDate);
    const msgCount = dateInfo ? dateInfo.messageCount : data.totalMessages;
    etaEl.textContent = `Local · ${estimateOllamaTime(msgCount)}`;
  }

  $("upload-info").innerHTML = `
    <div class="stat-row"><span>📨 Mensagens</span><span class="value">${data.totalMessages}</span></div>
    <div class="stat-row"><span>📅 Dias</span><span class="value">${data.totalDays}</span></div>
    <div class="stat-row"><span>👥 Participantes</span><span class="value">${data.participants}</span></div>
    <div class="stat-row"><span>📆 Período</span><span class="value">${formatDateBR(data.oldestDate)} → ${formatDateBR(data.newestDate)}</span></div>
  `;

  const datesContainer = $("upload-dates");
  datesContainer.innerHTML = data.dates
    .map(
      (d) => `
    <button class="upload-date-btn ${d.date === state.uploadSelectedDate ? "active" : ""}" data-date="${d.date}">
      ${formatDateBR(d.date)}<span class="count">(${d.messageCount})</span>
    </button>
  `
    )
    .join("");

  datesContainer.querySelectorAll(".upload-date-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      datesContainer.querySelectorAll(".upload-date-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.uploadSelectedDate = btn.dataset.date;

      // Update Ollama ETA for selected date
      const dateInfo = data.dates.find((d) => d.date === btn.dataset.date);
      const etaEl = $("upload-ollama-eta");
      if (etaEl && dateInfo) {
        etaEl.textContent = `Local · ${estimateOllamaTime(dateInfo.messageCount)}`;
      }
    });
  });

  document.querySelectorAll(".upload-levels .level-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".upload-levels .level-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.uploadLevel = parseInt(card.dataset.level);
    });
  });

  document.querySelectorAll(".upload-privacy .privacy-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".upload-privacy .privacy-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.uploadPrivacy = card.dataset.privacy;
    });
  });

  document.querySelectorAll(".upload-ai .ai-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".upload-ai .ai-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.uploadAI = card.dataset.ai;
    });
  });
}

async function generateUploadSummary() {
  if (!state.uploadId || !state.uploadSelectedDate) {
    showToast("Selecione um dia para resumir", "error");
    return;
  }

  const providerLabel = state.uploadAI === "ollama" ? "🖥️ Ollama Local" : "☁️ Groq Online";
  showLoadingWithProgress(`${providerLabel} — Gerando resumo...`);

  try {
    const response = await api(`/upload/${state.uploadId}/summarize`, {
      method: "POST",
      body: JSON.stringify({
        dateFrom: state.uploadSelectedDate,
        dateTo: state.uploadSelectedDate,
        level: state.uploadLevel,
        privacy: state.uploadPrivacy,
        aiProvider: state.uploadAI,
      }),
    });

    // If it has a jobId, poll for progress. Otherwise it returned directly.
    if (response.jobId && !response.summary) {
      state.selectedGroup = { name: "Arquivo importado" };
      startProgressPolling(response.jobId);
    } else {
      state.summary = response;
      state.selectedGroup = { name: "Arquivo importado" };
      renderResult(response);
      showScreen("screen-result");
      hideLoading();
    }
  } catch (err) {
    showToast(err.message, "error");
    hideLoading();
  }
}

// ============================================
// Contact Search Filter
// ============================================

function setupContactSearch() {
  $("contact-search").addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    const isAllTab = $("tab-all").classList.contains("active");
    const source = isAllTab && state.allContacts ? state.allContacts : state.contacts;
    const filtered = source.filter((c) =>
      c.name.toLowerCase().includes(query) ||
      (c.number && c.number.includes(query))
    );
    renderContacts(filtered);
  });
}

// ============================================
// Copy to Clipboard
// ============================================

async function copySummary() {
  if (!state.summary) return;
  try {
    const formatted = toWhatsAppFormat(
      state.summary.summary,
      state.selectedGroup?.name,
      state.summary.stats
    );
    await navigator.clipboard.writeText(formatted);
    showToast("📋 Copiado formatado para WhatsApp!", "success");
  } catch {
    showToast("Erro ao copiar", "error");
  }
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
  setupOptionButtons();
  setupContactSearch();
  setupGroupSearch();

  // Messages screen
  $("btn-back-to-groups").addEventListener("click", () => showScreen("screen-groups"));
  $("btn-go-summarize").addEventListener("click", goToSummarizeOptions);

  // Options screen
  $("btn-summarize").addEventListener("click", generateSummary);
  $("btn-back-groups").addEventListener("click", () => showScreen("screen-messages"));

  // Result screen
  $("btn-back-options").addEventListener("click", () => showScreen("screen-options"));
  $("btn-send-whatsapp").addEventListener("click", openSendScreen);
  $("btn-copy").addEventListener("click", copySummary);
  $("btn-new-summary").addEventListener("click", () => {
    state.summary = null;
    state.groupMessages = [];
    showScreen("screen-groups");
  });

  // Send screen
  $("btn-back-result").addEventListener("click", () => showScreen("screen-result"));

  // Upload
  $("btn-upload").addEventListener("click", () => $("file-upload").click());
  $("file-upload").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFileUpload(e.target.files[0]);
    e.target.value = "";
  });
  $("btn-back-upload").addEventListener("click", () => showScreen("screen-groups"));
  $("btn-upload-summarize").addEventListener("click", generateUploadSummary);

  // History
  $("btn-usage").addEventListener("click", openUsage);
  $("btn-back-usage").addEventListener("click", () => showScreen("screen-groups"));
  $("btn-history").addEventListener("click", openHistory);
  $("btn-back-history").addEventListener("click", () => showScreen("screen-groups"));
  $("btn-back-history-list").addEventListener("click", openHistory);
  $("btn-history-copy").addEventListener("click", copyHistoryEntry);
  $("btn-history-send").addEventListener("click", sendHistoryEntry);
  $("btn-clear-history").addEventListener("click", clearAllHistory);

  // Settings
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-back-settings").addEventListener("click", () => {
    stopOllamaPoll();
    showScreen("screen-groups");
  });
  $("btn-save-settings").addEventListener("click", saveSettings);
  $("btn-run-auto-now").addEventListener("click", runAutoSummaryNow);
  $("btn-ollama-pull").addEventListener("click", pullOllamaModel);
}

// ============================================
// ============================================
// Usage Screen
// ============================================

async function openUsage() {
  showScreen("screen-usage");
  $("usage-overview").innerHTML = '<div class="loading-placeholder">Carregando dados de uso...</div>';
  $("usage-details").innerHTML = "";

  try {
    const stats = await api("/usage");
    renderUsage(stats);
  } catch (err) {
    $("usage-overview").innerHTML = `<div class="usage-error">❌ Erro: ${err.message}</div>`;
  }
}

function renderUsage(stats) {
  const p = stats.projections;
  const limits = p.primaryModelLimits;

  const tokensPct = limits.tpd > 0 ? Math.round((p.tokensUsedToday / limits.tpd) * 100) : 0;
  const requestsPct = limits.rpd > 0 ? Math.round((p.requestsUsedToday / limits.rpd) * 100) : 0;

  let overviewHtml = `
    <div class="usage-model-badge">🤖 ${escapeHtml(limits.modelLabel)}</div>

    <div class="usage-cards">
      <div class="usage-card">
        <div class="usage-card-title">🔤 Tokens hoje</div>
        <div class="usage-bar">
          <div class="usage-bar-fill ${tokensPct > 80 ? 'usage-bar-danger' : tokensPct > 50 ? 'usage-bar-warn' : ''}" style="width: ${Math.min(tokensPct, 100)}%"></div>
        </div>
        <div class="usage-card-numbers">
          <span>${p.tokensUsedToday.toLocaleString("pt-BR")} usados</span>
          <span>${p.tokensRemainingToday.toLocaleString("pt-BR")} restantes</span>
        </div>
        <div class="usage-card-limit">${tokensPct}% de ${limits.tpd.toLocaleString("pt-BR")} tokens/dia</div>
      </div>

      <div class="usage-card">
        <div class="usage-card-title">📨 Requisições hoje</div>
        <div class="usage-bar">
          <div class="usage-bar-fill ${requestsPct > 80 ? 'usage-bar-danger' : requestsPct > 50 ? 'usage-bar-warn' : ''}" style="width: ${Math.min(requestsPct, 100)}%"></div>
        </div>
        <div class="usage-card-numbers">
          <span>${p.requestsUsedToday} usadas</span>
          <span>${p.requestsRemainingToday} restantes</span>
        </div>
        <div class="usage-card-limit">${requestsPct}% de ${limits.rpd.toLocaleString("pt-BR")} req/dia</div>
      </div>
    </div>

    <div class="usage-projection ${p.canFinishDay ? 'usage-ok' : 'usage-warning'}">
      <div class="usage-projection-title">${p.canFinishDay ? '✅ Uso normal' : '⚠️ Limite próximo!'}</div>
      <div class="usage-projection-detail">
        ~${p.avgTokensPerCall.toLocaleString("pt-BR")} tokens/chamada · 
        ~<strong>${p.estimatedRemainingCalls}</strong> resumos restantes hoje
      </div>
    </div>

    <div class="usage-limits-grid">
      <div class="usage-limit-item">
        <span class="usage-limit-label">⚡ Req/min</span>
        <span class="usage-limit-value">${limits.rpm}</span>
      </div>
      <div class="usage-limit-item">
        <span class="usage-limit-label">📨 Req/dia</span>
        <span class="usage-limit-value">${limits.rpd.toLocaleString("pt-BR")}</span>
      </div>
      <div class="usage-limit-item">
        <span class="usage-limit-label">🔤 Tokens/min</span>
        <span class="usage-limit-value">${limits.tpm.toLocaleString("pt-BR")}</span>
      </div>
      <div class="usage-limit-item">
        <span class="usage-limit-label">🔤 Tokens/dia</span>
        <span class="usage-limit-value">${limits.tpd.toLocaleString("pt-BR")}</span>
      </div>
    </div>
  `;

  // Whisper (audio) section
  if (stats.whisper) {
    const w = stats.whisper;
    const whisperReqPct = w.requestsLimitPerDay > 0 ? Math.round((w.requestsUsedToday / w.requestsLimitPerDay) * 100) : 0;
    overviewHtml += `
      <div class="usage-card" style="margin-top: 12px; border-left: 3px solid #9b59b6;">
        <div class="usage-card-title">🎤 Whisper (Áudio)</div>
        <div class="usage-bar">
          <div class="usage-bar-fill ${whisperReqPct > 80 ? 'usage-bar-danger' : ''}" style="width: ${Math.min(whisperReqPct, 100)}%"></div>
        </div>
        <div class="usage-card-numbers">
          <span>${w.requestsUsedToday} transcrições</span>
          <span>${w.audioSecondsUsedToday}s de áudio</span>
        </div>
        <div class="usage-card-limit">
          Limite: ${w.requestsLimitPerDay.toLocaleString("pt-BR")} req/dia · ${w.audioSecondsLimitPerHour.toLocaleString("pt-BR")}s/hora
        </div>
      </div>
    `;
  }

  $("usage-overview").innerHTML = overviewHtml;

  // Details section
  let detailsHtml = "";

  // By source today
  if (stats.today.totalRequests > 0) {
    detailsHtml += `<div class="usage-section">`;
    detailsHtml += `<h3>📋 Por fonte hoje</h3>`;
    detailsHtml += `<div class="usage-source-list">`;
    const sourceIcons = { bot: "🤖", dashboard: "🖥️", auto: "⏰", dm: "💬", qa: "❓", upload: "📁" };
    for (const [source, data] of Object.entries(stats.today.bySource)) {
      const icon = sourceIcons[source] || "📱";
      const audioInfo = data.audioSeconds > 0 ? ` · ${data.audioSeconds}s áudio` : "";
      detailsHtml += `
        <div class="usage-source-item">
          <span>${icon} ${source}</span>
          <span>${data.requests} chamadas · ${data.tokens.toLocaleString("pt-BR")} tokens${audioInfo}</span>
        </div>
      `;
    }
    detailsHtml += `</div></div>`;
  }

  // Last 7 days chart
  detailsHtml += `<div class="usage-section">`;
  detailsHtml += `<h3>📅 Últimos 7 dias</h3>`;
  detailsHtml += `<div class="usage-7days">`;

  const maxTokens7d = Math.max(...stats.last7Days.map(d => d.totalTokens), 1);
  for (const day of stats.last7Days.reverse()) {
    const dayLabel = new Date(day.date + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit" });
    const heightPct = Math.round((day.totalTokens / maxTokens7d) * 100);
    detailsHtml += `
      <div class="usage-day-col">
        <div class="usage-day-bar-container">
          <div class="usage-day-bar" style="height: ${Math.max(heightPct, 2)}%" title="${day.totalTokens.toLocaleString('pt-BR')} tokens · ${day.totalRequests} req"></div>
        </div>
        <div class="usage-day-label">${dayLabel}</div>
        <div class="usage-day-value">${day.totalRequests > 0 ? day.totalRequests + ' req' : '-'}</div>
      </div>
    `;
  }
  detailsHtml += `</div></div>`;

  $("usage-details").innerHTML = detailsHtml;
}

// ============================================
// Settings Screen
// ============================================

let settingsConfig = null;

async function openSettings() {
  showScreen("screen-settings");
  showLoading("Carregando configurações...");
  try {
    const [config, aiStatus] = await Promise.all([
      api("/settings"),
      api("/settings/ai-status"),
    ]);
    settingsConfig = config;
    renderSettings(config, aiStatus);
    loadOllamaModels();
  } catch (err) {
    showToast("Erro ao carregar configurações: " + err.message, "error");
    showScreen("screen-groups");
  } finally {
    hideLoading();
  }
}

function renderSettings(config, aiStatus) {
  // Auto-summary toggles
  $("cfg-auto-enabled").checked = config.autoSummary?.enabled || false;
  $("cfg-auto-time").value = config.autoSummary?.time || "20:00";

  // Auto-summary level
  setupSettingCards(
    "cfg-auto-level",
    "level-card",
    "level",
    String(config.autoSummary?.level || 3)
  );

  // Auto-summary privacy
  setupSettingCards(
    "cfg-auto-privacy",
    "privacy-card",
    "privacy",
    config.autoSummary?.privacy || "smart"
  );

  // Bot toggles
  $("cfg-bot-enabled").checked = config.bot?.enabled !== false;
  $("cfg-bot-cooldown").value = config.bot?.rateLimitMinutes || 60;

  // Bot level
  setupSettingCards(
    "cfg-bot-level",
    "level-card",
    "level",
    String(config.bot?.level || 3)
  );

  // Bot privacy
  setupSettingCards(
    "cfg-bot-privacy",
    "privacy-card",
    "privacy",
    config.bot?.privacy || "smart"
  );

  // AI provider
  setupSettingCards("cfg-ai-provider", "ai-card", "ai", config.ai?.defaultProvider || "groq");

  // AI status
  const statusParts = [];
  if (aiStatus.groq?.available) {
    statusParts.push("☁️ Groq: ✅ Conectado");
  } else {
    statusParts.push("☁️ Groq: ❌ " + (aiStatus.groq?.error || "Indisponível"));
  }
  if (aiStatus.ollama?.available) {
    statusParts.push("🖥️ Ollama: ✅ Online (" + (aiStatus.ollama.activeModel || "?") + ")");
  } else {
    statusParts.push("🖥️ Ollama: ❌ Offline");
  }
  $("cfg-ai-status").innerHTML = statusParts.join("<br>");

  // Load groups for checkboxes, contact for sendTo, and group rules
  renderSettingsGroups(config);
  renderSettingsSendTo(config);
  renderGroupRules(config);
}

function setupSettingCards(containerId, cardClass, dataAttr, activeValue) {
  const container = $(containerId);
  if (!container) return;
  container.querySelectorAll("." + cardClass).forEach((card) => {
    card.classList.toggle("active", card.dataset[dataAttr] === activeValue);
  });

  container.onclick = (e) => {
    const card = e.target.closest("." + cardClass);
    if (!card) return;
    container.querySelectorAll("." + cardClass).forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
  };
}

async function renderSettingsGroups(config) {
  const autoGroupsContainer = $("cfg-auto-groups");
  const botGroupsContainer = $("cfg-bot-groups");

  if (state.groups.length === 0) {
    try {
      const data = await api("/groups");
      state.groups = data.groups;
    } catch {
      autoGroupsContainer.innerHTML = '<span class="setting-hint">Conecte ao WhatsApp primeiro</span>';
      botGroupsContainer.innerHTML = '<span class="setting-hint">Conecte ao WhatsApp primeiro</span>';
      return;
    }
  }

  const allGroups = state.groups.filter(
    (g) => g.chatType === "group" || g.chatType === "community-group" || g.chatType === "announcement"
  );

  const autoSelected = new Set(config.autoSummary?.groups || []);
  const botSelected = new Set(config.bot?.allowedGroups || []);

  autoGroupsContainer.innerHTML = allGroups
    .map(
      (g) => `
      <div class="checkbox-item">
        <input type="checkbox" id="auto-grp-${g.id}" value="${g.id}" ${autoSelected.has(g.id) ? "checked" : ""} />
        <label for="auto-grp-${g.id}">${escapeHtml(g.name)}</label>
      </div>
    `
    )
    .join("");

  botGroupsContainer.innerHTML = allGroups
    .map(
      (g) => `
      <div class="checkbox-item">
        <input type="checkbox" id="bot-grp-${g.id}" value="${g.id}" ${botSelected.has(g.id) ? "checked" : ""} />
        <label for="bot-grp-${g.id}">${escapeHtml(g.name)}</label>
      </div>
    `
    )
    .join("");
}

async function renderSettingsSendTo(config) {
  const select = $("cfg-auto-sendto");
  select.innerHTML = '<option value="">Enviar no próprio grupo</option>';

  try {
    const data = await api("/groups/list/contacts");
    for (const c of data.contacts) {
      const selected = config.autoSummary?.sendTo === c.id ? "selected" : "";
      const icon = c.chatType === "group" ? "👥" : c.chatType === "contact" ? "👤" : "📌";
      select.innerHTML += `<option value="${c.id}" ${selected}>${icon} ${escapeHtml(c.name)}</option>`;
    }
  } catch {
    // Contacts not available yet
  }
}

async function renderGroupRules(config) {
  const container = $("cfg-group-rules");
  if (!container) return;

  if (state.groups.length === 0) {
    try {
      const data = await api("/groups");
      state.groups = data.groups;
    } catch {
      container.innerHTML = '<span class="setting-hint">Conecte ao WhatsApp primeiro</span>';
      return;
    }
  }

  const allGroups = state.groups.filter(
    (g) => g.chatType === "group" || g.chatType === "community-group" || g.chatType === "announcement"
  );

  const rules = config.groupRules || {};

  const groupsWithRules = allGroups.filter((g) => rules[g.id]);
  const groupsWithoutRules = allGroups.filter((g) => !rules[g.id]);

  let html = "";

  for (const g of groupsWithRules) {
    html += `
      <div class="group-rule-item" data-group-id="${g.id}">
        <div class="group-rule-header">
          <span class="group-rule-name">📋 ${escapeHtml(g.name)}</span>
          <button class="btn-icon btn-remove-rule" onclick="removeGroupRule('${g.id}')" title="Remover regra">🗑️</button>
        </div>
        <textarea class="group-rule-text" placeholder="Instruções para a IA ao resumir este grupo...">${escapeHtml(rules[g.id] || "")}</textarea>
      </div>
    `;
  }

  html += `
    <div class="group-rule-add">
      <select id="group-rule-add-select" class="setting-select">
        <option value="">+ Adicionar regra para um grupo...</option>
        ${groupsWithoutRules.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}
      </select>
    </div>
  `;

  container.innerHTML = html;

  const select = $("group-rule-add-select");
  if (select) {
    select.addEventListener("change", () => {
      const groupId = select.value;
      if (!groupId) return;
      const group = allGroups.find((g) => g.id === groupId);
      if (!group) return;

      const newItem = document.createElement("div");
      newItem.className = "group-rule-item";
      newItem.dataset.groupId = groupId;
      newItem.innerHTML = `
        <div class="group-rule-header">
          <span class="group-rule-name">📋 ${escapeHtml(group.name)}</span>
          <button class="btn-icon btn-remove-rule" onclick="removeGroupRule('${groupId}')" title="Remover regra">🗑️</button>
        </div>
        <textarea class="group-rule-text" placeholder="Instruções para a IA ao resumir este grupo..."></textarea>
      `;
      container.insertBefore(newItem, select.parentElement);

      select.querySelector(`option[value="${groupId}"]`).remove();
      select.value = "";
    });
  }
}

function removeGroupRule(groupId) {
  const item = document.querySelector(`.group-rule-item[data-group-id="${groupId}"]`);
  if (item) item.remove();
}

function collectGroupRules() {
  const rules = {};
  document.querySelectorAll(".group-rule-item").forEach((item) => {
    const groupId = item.dataset.groupId;
    const text = item.querySelector(".group-rule-text")?.value?.trim();
    if (groupId && text) {
      rules[groupId] = text;
    }
  });
  return rules;
}

function getActiveCardValue(containerId, cardClass, dataAttr) {
  const container = $(containerId);
  if (!container) return null;
  const active = container.querySelector("." + cardClass + ".active");
  return active ? active.dataset[dataAttr] : null;
}

function getCheckedGroupIds(containerId) {
  const container = $(containerId);
  if (!container) return [];
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(
    (cb) => cb.value
  );
}

async function saveSettings() {
  const updates = {
    autoSummary: {
      enabled: $("cfg-auto-enabled").checked,
      time: $("cfg-auto-time").value || "20:00",
      level: parseInt(getActiveCardValue("cfg-auto-level", "level-card", "level") || "3"),
      privacy: getActiveCardValue("cfg-auto-privacy", "privacy-card", "privacy") || "smart",
      sendTo: $("cfg-auto-sendto").value || "",
      groups: getCheckedGroupIds("cfg-auto-groups"),
    },
    bot: {
      enabled: $("cfg-bot-enabled").checked,
      rateLimitMinutes: parseInt($("cfg-bot-cooldown").value) || 60,
      level: parseInt(getActiveCardValue("cfg-bot-level", "level-card", "level") || "3"),
      privacy: getActiveCardValue("cfg-bot-privacy", "privacy-card", "privacy") || "smart",
      allowedGroups: getCheckedGroupIds("cfg-bot-groups"),
    },
    ai: {
      defaultProvider: getActiveCardValue("cfg-ai-provider", "ai-card", "ai") || "groq",
    },
    groupRules: collectGroupRules(),
  };

  try {
    await api("/settings", {
      method: "PUT",
      body: JSON.stringify(updates),
    });

    const toast = $("settings-toast");
    toast.textContent = "✅ Configurações salvas!";
    toast.className = "settings-toast success";
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 3000);
  } catch (err) {
    const toast = $("settings-toast");
    toast.textContent = "❌ Erro: " + err.message;
    toast.className = "settings-toast error";
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 4000);
  }
}

async function runAutoSummaryNow() {
  showLoading("Executando auto-resumo...");
  try {
    const result = await api("/settings/auto-summary/run", { method: "POST" });

    let msg = "Auto-resumo executado!\n\n";
    if (result.results && result.results.length > 0) {
      for (const r of result.results) {
        msg += r.sent
          ? `✅ ${r.groupName}\n`
          : `❌ ${r.groupName}: ${r.error || "Erro"}\n`;
      }
    } else {
      msg += "Nenhum grupo processado.";
    }

    showToast(msg, result.success ? "success" : "error");
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  } finally {
    hideLoading();
  }
}

// ============================================
// History
// ============================================

let currentHistoryEntry = null;

let searchDebounceTimer = null;

function setupHistorySearch() {
  const input = $("history-search");
  if (!input) return;

  input.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    const query = input.value.trim();

    if (!query) {
      $("history-search-results").classList.add("hidden");
      $("history-list").classList.remove("hidden");
      return;
    }

    searchDebounceTimer = setTimeout(async () => {
      try {
        const data = await api(`/history/search?q=${encodeURIComponent(query)}`);
        const container = $("history-search-results");

        if (data.total === 0) {
          container.innerHTML = `<div class="history-empty">Nenhum resultado para "${escapeHtml(query)}"</div>`;
        } else {
          container.innerHTML = `<div class="history-search-count">${data.total} resultado(s)</div>` +
            data.results.map((e) => `
              <div class="history-item" onclick="openHistoryDetail('${e.id}')">
                <div class="history-item-header">
                  <span class="history-item-group">${escapeHtml(e.groupName)}</span>
                  <span class="history-item-date">${new Date(e.createdAt).toLocaleDateString("pt-BR")}</span>
                </div>
                <div class="history-item-preview">${escapeHtml(e.summaryPreview)}</div>
                <div class="history-item-meta">${e.totalMessages} msgs · ${e.source}</div>
              </div>
            `).join("");
        }

        container.classList.remove("hidden");
        $("history-list").classList.add("hidden");
      } catch (err) {
        console.error("Search error:", err);
      }
    }, 400);
  });
}

async function openHistory() {
  showScreen("screen-history");
  $("history-search").value = "";
  $("history-search-results").classList.add("hidden");
  $("history-list").classList.remove("hidden");
  setupHistorySearch();
  const list = $("history-list");
  list.innerHTML = `<div class="loading-placeholder"><div class="spinner"></div>Carregando...</div>`;

  try {
    const data = await api("/history");
    renderHistoryList(data.entries || []);
  } catch (err) {
    list.innerHTML = `<div class="loading-placeholder">Erro: ${err.message}</div>`;
  }
}

function renderHistoryList(entries) {
  const list = $("history-list");

  if (entries.length === 0) {
    list.innerHTML = `<div class="loading-placeholder">Nenhum resumo no histórico ainda.<br><span style="font-size:0.78rem; opacity:0.6;">Gere um resumo e ele aparecerá aqui!</span></div>`;
    return;
  }

  const sourceIcons = { live: "💬", upload: "📁", auto: "⏰", bot: "🤖" };
  const sourceLabels = { live: "Dashboard", upload: "Arquivo", auto: "Auto", bot: "Bot" };
  const levelLabels = { 1: "⚡", 2: "📝", 3: "📋", 4: "📖", 5: "📌" };

  list.innerHTML = entries
    .map((e) => {
      const dateStr = e.dateFrom === e.dateTo
        ? formatDateBR(e.dateFrom)
        : `${formatDateBR(e.dateFrom)} a ${formatDateBR(e.dateTo)}`;
      const created = new Date(e.createdAt);
      const timeStr = `${created.getHours().toString().padStart(2,"0")}:${created.getMinutes().toString().padStart(2,"0")}`;

      return `
        <div class="history-card" data-id="${e.id}">
          <span class="history-source">${sourceIcons[e.source] || "📋"}</span>
          <div class="history-info">
            <h4>${escapeHtml(e.groupName)}</h4>
            <div class="history-meta">
              <span>📅 ${dateStr}</span>
              <span>💬 ${e.totalMessages} msgs</span>
              <span>${levelLabels[e.level] || "📋"} ${e.provider}</span>
              <span>🕐 ${timeStr}</span>
            </div>
          </div>
          <span class="history-arrow">›</span>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".history-card").forEach((card) => {
    card.addEventListener("click", () => openHistoryDetail(card.dataset.id));
  });
}

async function openHistoryDetail(id) {
  showLoading("Carregando resumo...");
  try {
    const entry = await api(`/history/${id}`);
    currentHistoryEntry = entry;

    $("history-detail-title").textContent = `📋 ${entry.groupName}`;

    const dateStr = entry.dateFrom === entry.dateTo
      ? formatDateBR(entry.dateFrom)
      : `${formatDateBR(entry.dateFrom)} a ${formatDateBR(entry.dateTo)}`;
    const sourceLabels = { live: "Dashboard", upload: "Arquivo", auto: "Auto-resumo", bot: "Bot" };
    $("history-detail-info").textContent = `${dateStr} · ${sourceLabels[entry.source] || entry.source} · ${new Date(entry.createdAt).toLocaleString("pt-BR")}`;

    $("history-detail-content").innerHTML = renderMarkdown(entry.summary);

    $("history-detail-stats").innerHTML = `
      <span>💬 ${entry.totalMessages} msgs</span>
      <span>👥 ${entry.participants} participantes</span>
      <span>⚡ ${(entry.processingTime / 1000).toFixed(1)}s</span>
      <span>📦 ${entry.chunks} parte(s)</span>
      <span>🤖 ${entry.provider}</span>
    `;

    showScreen("screen-history-detail");
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  } finally {
    hideLoading();
  }
}

async function copyHistoryEntry() {
  if (!currentHistoryEntry) return;
  try {
    const formatted = toWhatsAppFormat(
      currentHistoryEntry.summary,
      currentHistoryEntry.groupName,
      {
        dateFrom: currentHistoryEntry.dateFrom,
        dateTo: currentHistoryEntry.dateTo,
        totalMessages: currentHistoryEntry.totalMessages,
        participants: currentHistoryEntry.participants,
      }
    );
    await navigator.clipboard.writeText(formatted);
    showToast("📋 Copiado para WhatsApp!", "success");
  } catch {
    showToast("Erro ao copiar", "error");
  }
}

async function sendHistoryEntry() {
  if (!currentHistoryEntry) return;
  // Set state for send screen
  state.summary = {
    summary: currentHistoryEntry.summary,
    stats: {
      dateFrom: currentHistoryEntry.dateFrom,
      dateTo: currentHistoryEntry.dateTo,
      totalMessages: currentHistoryEntry.totalMessages,
      participants: currentHistoryEntry.participants,
    },
  };
  state.selectedGroup = { name: currentHistoryEntry.groupName };
  openSendScreen();
}

async function clearAllHistory() {
  if (!confirm("Limpar todo o histórico? Isso não pode ser desfeito.")) return;
  try {
    await api("/history", { method: "DELETE" });
    showToast("🗑️ Histórico limpo", "success");
    openHistory();
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

// ============================================
// Ollama Management
// ============================================

let ollamaPollInterval = null;

async function loadOllamaModels() {
  const list = $("ollama-models-list");
  const badge = $("ollama-status-badge");

  try {
    const statusResp = await api("/ollama/status");
    if (!statusResp.available) {
      badge.textContent = "Offline";
      badge.className = "badge badge-disconnected";
      list.innerHTML = `<div class="loading-placeholder" style="padding: 16px;">
        🖥️ Ollama não está rodando.<br>
        <span style="font-size:0.8rem; color: var(--text-secondary)">Instale com: winget install Ollama.Ollama<br>Inicie com: ollama serve</span>
      </div>`;
      return;
    }

    badge.textContent = "Online";
    badge.className = "badge badge-connected";

    const data = await api("/ollama/models");
    const models = data.models || [];

    if (models.length === 0) {
      list.innerHTML = `<div class="loading-placeholder" style="padding: 16px;">Nenhum modelo instalado. Baixe um abaixo!</div>`;
      return;
    }

    list.innerHTML = models
      .map(
        (m) => `
        <div class="ollama-model-card ${m.isActive ? "active" : ""}">
          <div class="ollama-model-info">
            <div class="ollama-model-name">${escapeHtml(m.name)} ${m.isActive ? "✅" : ""}</div>
            <div class="ollama-model-meta">${m.sizeFormatted} · ${m.parameterSize || m.family || ""} ${m.quantization ? "· " + m.quantization : ""}</div>
          </div>
          <div class="ollama-model-actions">
            ${m.isActive ? "" : `<button class="btn-sm-action" onclick="setActiveOllamaModel('${m.name}')">Usar</button>`}
            <button class="btn-sm-action danger" onclick="deleteOllamaModel('${m.name}')">🗑️</button>
          </div>
        </div>
      `
      )
      .join("");
  } catch (err) {
    badge.textContent = "Erro";
    badge.className = "badge badge-disconnected";
    list.innerHTML = `<div class="loading-placeholder" style="padding: 16px;">Erro: ${err.message}</div>`;
  }
}

async function setActiveOllamaModel(modelName) {
  try {
    await api("/ollama/active", {
      method: "POST",
      body: JSON.stringify({ model: modelName }),
    });
    showToast(`✅ Modelo ativo: ${modelName}`, "success");
    await loadOllamaModels();
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

async function deleteOllamaModel(modelName) {
  if (!confirm(`Excluir o modelo "${modelName}"? Isso liberará espaço em disco.`)) return;

  try {
    await api(`/ollama/models/${encodeURIComponent(modelName)}`, {
      method: "DELETE",
    });
    showToast(`🗑️ Modelo ${modelName} excluído`, "success");
    await loadOllamaModels();
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

async function pullOllamaModel() {
  const select = $("ollama-model-select");
  const model = select.value;
  if (!model) return;

  try {
    await api("/ollama/pull", {
      method: "POST",
      body: JSON.stringify({ model }),
    });

    // Show progress
    $("ollama-pull-progress").classList.remove("hidden");
    $("ollama-pull-status").textContent = "Iniciando download...";
    $("ollama-pull-fill").style.width = "5%";

    // Poll for progress
    stopOllamaPoll();
    ollamaPollInterval = setInterval(async () => {
      try {
        const progress = await api(`/ollama/pull/${encodeURIComponent(model)}/progress`);

        $("ollama-pull-fill").style.width = progress.percent + "%";

        if (progress.status === "error") {
          $("ollama-pull-status").textContent = `❌ Erro: ${progress.error || "Falha no download"}`;
          stopOllamaPoll();
        } else if (progress.done && progress.status === "success") {
          $("ollama-pull-status").textContent = "✅ Download completo!";
          $("ollama-pull-fill").style.width = "100%";
          stopOllamaPoll();
          await loadOllamaModels();
          setTimeout(() => $("ollama-pull-progress").classList.add("hidden"), 3000);
        } else {
          const statusText = progress.status === "downloading"
            ? `📥 Baixando... ${progress.percent}%`
            : `${progress.status}... ${progress.percent}%`;
          $("ollama-pull-status").textContent = statusText;
        }
      } catch {
        // Ignore poll errors
      }
    }, 2000);
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

function stopOllamaPoll() {
  if (ollamaPollInterval) {
    clearInterval(ollamaPollInterval);
    ollamaPollInterval = null;
  }
}

// ============================================
// Init
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  startStatusPolling();
});
