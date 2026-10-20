(function () {
  "use strict";

  const STORAGE_KEY = "java-interview-flashcards:simple:v1";
  const INITIAL_CARDS_KEY = "java-interview-flashcards:content-version:v1";
  const LEGACY_KEY = "java-interview-flashcards:v1";
  const DELETED_CARDS_KEY = "java-interview-flashcards:deleted:v1";
  const SYNC_META_KEY = "java-interview-flashcards:sync:v2";
  const CLOUD_CONFIG_KEY = "java-interview-flashcards:private-link:v1";
  const VIEW_KEY = "java-interview-flashcards:view:v1";
  const OUTBOX_PREFIX = "java-interview-flashcards:outbox:v1:";
  const TAB_ID = crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
  const CLOUD_SYNC_ORIGIN = "https://java-interview-cards-for5634.netlify.app";
  const LEGACY_CLOUD_ORIGIN = "https://mint-interview-cards-sync.nutmeg-gem-5818.chatgpt.site";
  // Retain the first browser progress snapshot before a cloud read can replace it.
  const PRE_CLOUD_PROGRESS_KEY = "java-interview-flashcards:before-cloud-progress:v1";
  try {
    if (!localStorage.getItem(PRE_CLOUD_PROGRESS_KEY)) {
      const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(previous) && previous.length) localStorage.setItem(PRE_CLOUD_PROGRESS_KEY, JSON.stringify({ capturedAt: new Date().toISOString(), cards: previous.map(({ id, category, question, proficiency, starred }) => ({ id, category, question, proficiency, starred })) }));
    }
  } catch {}
  const PROFICIENCY = ["生疏", "一般", "熟练"];
  const DEFAULT_CATEGORIES = ["Agent", "MySQL", "计算机网络", "Spring Boot", "JVM", "Redis", "操作系统"];
  const els = Object.fromEntries(["searchInput", "categoryFilters", "starredFilterButton", "cardCount", "cardList", "flashcard", "flipButton", "cardCategory", "cardProficiency", "cardQuestion", "cardFlipTip", "cardCategoryBack", "cardProficiencyBack", "cardAnswerLabel", "cardAnswer", "showDetailedButton", "starToggleButton", "starToggleButtonBack", "weakButton", "normalButton", "masteredButton", "totalCount", "weakCount", "normalCount", "masteredCount", "studyTip", "toast", "localStorageNotice", "exportProgressButton", "importProgressButton", "progressFileInput"].map((id) => [id, document.getElementById(id)]));
  let recoveredLegacyCards = 0;
  let refreshedLegacyCards = 0;
  let serverStorageLoaded = false;
  let serverSavePending = false;
  let serverWriteQueue = Promise.resolve(true);
  let serverAvailable = false;
  let serverFileExists = false;
  let cloudConfig = readCloudConfiguration();
  let syncMetaStorageKey = cloudConfig ? `${SYNC_META_KEY}:cloud` : SYNC_META_KEY;
  const storedSyncMeta = readJson(syncMetaStorageKey, null);
  let serverRevision = storedSyncMeta?.revision || null;
  let serverBaseCards = Array.isArray(storedSyncMeta?.cards) ? storedSyncMeta.cards.map(normalizeCard) : [];
  let serverBaseDeleted = Array.isArray(storedSyncMeta?.deletedCardIds) ? storedSyncMeta.deletedCardIds : [];
  let syncDirty = Boolean(storedSyncMeta?.dirty);
  let syncPhase = "checking";
  let lastSyncAt = Number(storedSyncMeta?.lastSyncAt) || 0;
  const journalAcks = new Map();
  let journalTrackingStarted = false;
  let undoRatings = [];
  try { undoRatings = JSON.parse(sessionStorage.getItem("interview-rating-undo:v1") || "[]"); if (!Array.isArray(undoRatings)) undoRatings = []; } catch {}
  let conflictPlan = null;
  let pollRunning = false;
  const storedDeletedIds = readJson(DELETED_CARDS_KEY, []);
  const deletedCardIds = new Set(Array.isArray(storedDeletedIds) ? storedDeletedIds.filter(id => typeof id === "string") : []);
  const savedView = readJson(VIEW_KEY, {});
  const state = { cards: loadCards(), query: typeof savedView.query === "string" ? savedView.query : "", category: typeof savedView.category === "string" ? savedView.category : "全部", starredOnly: Boolean(savedView.starredOnly), proficiency: PROFICIENCY.includes(savedView.proficiency) ? savedView.proficiency : "全部", activeId: typeof savedView.activeId === "string" ? savedView.activeId : null, revealStage: 0, loading: true };
  let browserBaseCards = state.cards.map(card => ({ ...card }));
  let browserBaseDeleted = [...deletedCardIds];
  if (cloudConfig && fingerprint(state.cards, deletedCardIds) !== fingerprint(serverBaseCards, serverBaseDeleted)) syncDirty = true;
  ["allCardsButton", "previousCardButton", "nextCardButton", "cardQuestionBack", "cardPosition", "collectionTitle", "masteryPercentage", "masteryMeter", "masteryFill"].forEach((id) => { els[id] = document.getElementById(id); });
  const editCurrentCardButton = document.getElementById("editCurrentCardButton");
  const newCardButton = document.getElementById("newCardButton");
  const deleteCurrentCardButton = document.getElementById("deleteCurrentCardButton");
  const cardEditorDialog = document.getElementById("cardEditorDialog");
  const cardEditorForm = document.getElementById("cardEditorForm");
  const cardEditorStatus = document.getElementById("cardEditorStatus");
  const editorCategorySelect = document.getElementById("editorCategorySelect");
  const editorNewCategoryField = document.getElementById("editorNewCategoryField");
  const NEW_EDITOR_CATEGORY = "__new_editor_category__";
  let editingCardId = null;
  let editorOriginalValues = "";
  let editorSaving = false;
  let editorMode = "edit";
  let newCardStarred = false;
  let pendingDeletion = false;

  function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function saveCards() {
    state.cards = state.cards.filter(card => !deletedCardIds.has(card.id));
    const journalKey = `${outboxScope()}${TAB_ID}`;
    const keys = [DELETED_CARDS_KEY, STORAGE_KEY, syncMetaStorageKey, journalKey];
    const previous = keys.map(key => localStorage.getItem(key));
    const previousDirty = syncDirty;
    try {
      const earlier = readJson(journalKey, null);
      localStorage.setItem(journalKey, JSON.stringify({ baseCards: earlier?.baseCards || browserBaseCards, baseDeleted: earlier?.baseDeleted || browserBaseDeleted, cards: state.cards, deletedCardIds: [...deletedCardIds], savedAt: Date.now() }));
      localStorage.setItem(DELETED_CARDS_KEY, JSON.stringify([...deletedCardIds]));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
      if (newCardButton && /^https?:$/.test(location.protocol)) { syncDirty = true; persistSyncMeta(); }
    } catch (error) {
      syncDirty = previousDirty;
      keys.forEach((key, index) => { try { if (previous[index] === null) localStorage.removeItem(key); else localStorage.setItem(key, previous[index]); } catch {} });
      setSyncStatus("error", "浏览器保存失败，请导出完整题库备份后重试");
      throw error;
    }
    browserBaseCards = state.cards.map(card => ({ ...card })); browserBaseDeleted = [...deletedCardIds];
    scheduleServerSave();
  }
  function outboxScope() { return `${OUTBOX_PREFIX}${cloudConfig ? "cloud" : "local"}:`; }
  function journals() {
    const pending = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(outboxScope())) continue;
      const raw = localStorage.getItem(key);
      try { const data = JSON.parse(raw); if (Array.isArray(data?.cards) && Array.isArray(data.baseCards) && Array.isArray(data.deletedCardIds)) pending.push({ key, raw, data }); } catch {}
    }
    return pending.sort((a, b) => a.data.savedAt - b.data.savedAt);
  }
  function captureInitialPending() {
    if (journalTrackingStarted) return;
    if (syncDirty && fingerprint(state.cards, deletedCardIds) !== fingerprint(serverBaseCards, serverBaseDeleted)) {
      const key = `${outboxScope()}${TAB_ID}`;
      localStorage.setItem(key, JSON.stringify({ baseCards: serverBaseCards, baseDeleted: serverBaseDeleted, cards: state.cards, deletedCardIds: [...deletedCardIds], savedAt: Date.now() }));
    }
    journalTrackingStarted = true;
  }
  function mergePendingTabs() {
    for (const journal of journals()) {
      if (journalAcks.get(journal.key) === journal.raw) continue;
      const payload = { cards: state.cards, deletedCardIds: [...deletedCardIds], revision: serverRevision, exists: serverFileExists };
      const plan = buildMergePlan(payload, { baseCards: journal.data.baseCards, localCards: journal.data.cards, localDeleted: new Set(journal.data.deletedCardIds) });
      plan.localOnly = true; plan.journal = journal;
      if (plan.conflicts.length) { conflictPlan = plan; syncDirty = true; persistSyncMeta(); setSyncStatus("conflict", "不同标签页的修改需要核对"); return false; }
      acceptMerge(plan);
    }
    return true;
  }
  function acknowledgeJournals() {
    for (const [key, raw] of journalAcks) if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    journalAcks.clear();
  }
  function pendingCardCount() {
    const base = new Map(serverBaseCards.map(c => [c.id, c]));
    const changed = new Set(state.cards.filter(c => JSON.stringify(c) !== JSON.stringify(base.get(c.id))).map(c => c.id));
    for (const c of serverBaseCards) if (deletedCardIds.has(c.id)) changed.add(c.id);
    const pending = journals();
    for (const journal of pending) {
      const before = new Map(journal.data.baseCards.map(c => [c.id, c]));
      for (const c of journal.data.cards) if (JSON.stringify(c) !== JSON.stringify(before.get(c.id))) changed.add(c.id);
      for (const id of journal.data.deletedCardIds) if (!(journal.data.baseDeleted || []).includes(id)) changed.add(id);
    }
    return syncDirty || pending.length ? changed.size : 0;
  }
  function rememberView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ activeId: state.activeId, query: state.query, category: state.category, starredOnly: state.starredOnly, proficiency: state.proficiency })); } catch {}
  }
  function createId() { return `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
  function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function formatText(value) {
    const formatted = escapeHtml(value)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
    const blocks = [];
    let paragraph = [];
    let bullets = [];
    const flushParagraph = () => { if (paragraph.length) { blocks.push(`<p>${paragraph.join("<br>")}</p>`); paragraph = []; } };
    const flushBullets = () => { if (bullets.length) { blocks.push(`<ul>${bullets.map((item) => `<li>${item}</li>`).join("")}</ul>`); bullets = []; } };
    for (const line of formatted.split("\n")) {
      if (!line.trim()) { flushParagraph(); flushBullets(); }
      else if (/^\s*[-*]\s+/.test(line)) { flushParagraph(); bullets.push(line.replace(/^\s*[-*]\s+/, "")); }
      else { flushBullets(); paragraph.push(line); }
    }
    flushParagraph(); flushBullets();
    return blocks.join("");
  }
  function conciseAnswer(answer) {
    const firstParagraph = String(answer || "").trim().split(/\n\s*\n/)[0].trim();
    if (firstParagraph.length <= 180) return firstParagraph;
    const sentence = firstParagraph.match(/^.{1,180}?[。！？；.!?]/)?.[0];
    return sentence || `${firstParagraph.slice(0, 180)}…`;
  }
  function showToast(message) { els.toast.textContent = message; els.toast.classList.add("visible"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove("visible"), 2400); }
  function proficiencyIndex(value) { return Math.max(0, PROFICIENCY.indexOf(value)); }
  function isLocalCardServer() { return serverAvailable; }
  function localApiOrigin() {
    return /^https?:$/.test(location.protocol) && (["localhost", "127.0.0.1"].includes(location.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname));
  }
  function validCloudConfiguration(config) { return [CLOUD_SYNC_ORIGIN, LEGACY_CLOUD_ORIGIN].includes(config?.origin) && typeof config.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(config.key); }
  function readCloudConfiguration() {
    const key = new URLSearchParams(location.hash.slice(1)).get("sync");
    if (key && validCloudConfiguration({ origin: CLOUD_SYNC_ORIGIN, key })) {
      const config = { origin: CLOUD_SYNC_ORIGIN, key };
      localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
      // The private key stays in browser storage, not in history or request URLs.
      try { history.replaceState(null, "", location.pathname + location.search); } catch {}
      return config;
    }
    const saved = readJson(CLOUD_CONFIG_KEY, null);
    if (!validCloudConfiguration(saved)) return null;
    const config = { origin: CLOUD_SYNC_ORIGIN, key: saved.key };
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
    return config;
  }
  function parsePrivateLink(value) {
    const url = new URL(value.trim());
    const config = { origin: url.origin, key: new URLSearchParams(url.hash.slice(1)).get("sync") };
    if (!validCloudConfiguration(config)) throw new Error("请粘贴你的完整专属链接，包括 #sync= 后面的内容。");
    return { origin: CLOUD_SYNC_ORIGIN, key: config.key };
  }
  function privateLink() { return cloudConfig ? `${cloudConfig.origin}/#sync=${cloudConfig.key}` : ""; }
  function selectCloudConfiguration(config) {
    if (!validCloudConfiguration(config)) throw new Error("专属链接格式不正确");
    config = { origin: CLOUD_SYNC_ORIGIN, key: config.key };
    cloudConfig = config;
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
    syncMetaStorageKey = `${SYNC_META_KEY}:cloud`;
    const meta = readJson(syncMetaStorageKey, null);
    serverRevision = meta?.revision || null;
    serverBaseCards = Array.isArray(meta?.cards) ? meta.cards.map(normalizeCard) : [];
    serverBaseDeleted = Array.isArray(meta?.deletedCardIds) ? meta.deletedCardIds : [];
    syncDirty = Boolean(meta?.dirty) || fingerprint(state.cards, deletedCardIds) !== fingerprint(serverBaseCards, serverBaseDeleted);
    serverStorageLoaded = false; serverFileExists = false; conflictPlan = null; serverAvailable = true;
    journalTrackingStarted = false; journalAcks.clear();
    persistSyncMeta();
  }
  async function localPrivateConfiguration() {
    if (!/^https?:$/.test(location.protocol) || !["localhost", "127.0.0.1"].includes(location.hostname)) return null;
    try {
      const response = await fetchWithTimeout("/api/cloud-sync-link", { cache: "no-store" });
      if (!response.ok) return null;
      const config = await response.json(); return validCloudConfiguration(config) ? config : null;
    } catch { return null; }
  }
  function libraryRequest(options = {}) {
    const headers = new Headers(options.headers || {});
    if (cloudConfig) headers.set("Authorization", `Bearer ${cloudConfig.key}`);
    const suffix = options.path || "";
    const url = (cloudConfig ? `${cloudConfig.origin}/api/interview-cards` : "/api/interview-cards") + suffix;
    const { path, ...requestOptions } = options;
    return fetchWithTimeout(url, { ...requestOptions, headers });
  }
  function persistSyncMeta() {
    localStorage.setItem(syncMetaStorageKey, JSON.stringify({ revision: serverRevision, cards: serverBaseCards, deletedCardIds: serverBaseDeleted, dirty: syncDirty, lastSyncAt }));
  }
  function setSyncStatus(phase, message) {
    syncPhase = phase;
    const status = document.getElementById("syncStatus");
    const retry = document.getElementById("retrySyncButton");
    if (!status || !retry) return;
    const pending = pendingCardCount();
    const time = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
    const text = !navigator.onLine ? `离线 · ${pending ? `${pending} 张待同步` : "已缓存的卡片可继续复习"}` : phase === "saved" ? `已同步${time ? ` · ${time}` : ""}` : `${cloudConfig ? message.replaceAll("电脑端", "云端").replaceAll("电脑", "云端").replaceAll("本机文件", "云端题库") : message}${pending ? ` · ${pending} 张待同步` : ""}`;
    status.textContent = text;
    const header = document.getElementById("headerSyncNote"); if (header) header.textContent = text;
    status.parentElement.dataset.phase = phase;
    retry.hidden = !["error", "conflict"].includes(phase);
    retry.textContent = phase === "conflict" ? "核对修改" : "重试同步";
  }
  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  function validServerLibrary(payload) {
    return payload?.syncVersion === 2 && typeof payload.revision === "string" && Array.isArray(payload.cards) && Array.isArray(payload.deletedCardIds) && payload.deletedCardIds.every(id => typeof id === "string") && new Set(payload.cards.map(card => card?.id)).size === payload.cards.length && payload.cards.every(card => card && typeof card.id === "string" && card.id && ["category", "question", "briefAnswer", "detailedAnswer"].every(key => typeof card[key] === "string") && PROFICIENCY.includes(card.proficiency) && typeof card.starred === "boolean");
  }
  function fingerprint(cards, deleted) { return JSON.stringify({ cards: cards.map(normalizeCard), deletedCardIds: [...deleted].sort() }); }
  function setServerBase(payload) {
    serverRevision = payload.revision;
    serverBaseCards = payload.cards.map(normalizeCard);
    serverBaseDeleted = [...payload.deletedCardIds];
    serverStorageLoaded = true;
    serverFileExists = payload.exists !== false;
    lastSyncAt = Date.now();
  }
  function replaceLibrary(cards, deleted) {
    const nextDeleted = new Set(deleted);
    const nextCards = cards.map(normalizeCard).filter(card => !nextDeleted.has(card.id));
    const previousCards = localStorage.getItem(STORAGE_KEY); const previousDeleted = localStorage.getItem(DELETED_CARDS_KEY);
    try {
      localStorage.setItem(DELETED_CARDS_KEY, JSON.stringify([...nextDeleted]));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextCards));
    } catch (error) {
      for (const [key, previous] of [[STORAGE_KEY, previousCards], [DELETED_CARDS_KEY, previousDeleted]]) { try { if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous); } catch {} }
      throw error;
    }
    state.cards = nextCards;
    deletedCardIds.clear(); nextDeleted.forEach(id => deletedCardIds.add(id));
    browserBaseCards = state.cards.map(card => ({ ...card })); browserBaseDeleted = [...deletedCardIds];
    if (state.category !== "全部" && !state.cards.some(card => card.category === state.category)) state.category = "全部";
    render();
  }
  function buildMergePlan(payload, options = {}) {
    const localDeleted = options.localDeleted || deletedCardIds;
    const base = new Map((options.baseCards || serverBaseCards).map(card => [card.id, card]));
    const local = new Map((options.localCards || state.cards).filter(card => !localDeleted.has(card.id)).map(card => [card.id, card]));
    const remote = new Map(payload.cards.map(normalizeCard).map(card => [card.id, card]));
    const plan = { cards: [], deleted: new Set([...localDeleted, ...payload.deletedCardIds]), conflicts: [], payload };
    const equal = (a, b) => JSON.stringify(a ? normalizeCard(a) : null) === JSON.stringify(b ? normalizeCard(b) : null);
    for (const id of new Set([...remote.keys(), ...local.keys(), ...base.keys()])) {
      const before = base.get(id); const mine = local.get(id); const theirs = remote.get(id);
      let chosen;
      if (!before && !mine && theirs && localDeleted.has(id)) {
        plan.conflicts.push({ id, local: mine, remote: theirs, fields: [] });
        continue;
      }
      if (equal(mine, before)) chosen = theirs;
      else if (equal(theirs, before) || equal(mine, theirs)) chosen = mine;
      else if (mine && theirs) {
        const merged = { id }; const fields = [];
        for (const key of ["category", "proficiency", "starred", "question", "briefAnswer", "detailedAnswer"]) {
          if (mine[key] === before?.[key]) merged[key] = theirs[key];
          else if (theirs[key] === before?.[key] || mine[key] === theirs[key]) merged[key] = mine[key];
          else { fields.push(key); merged[key] = theirs[key]; }
        }
        if (fields.length) { plan.conflicts.push({ id, local: mine, remote: theirs, merged, fields }); continue; }
        chosen = merged;
      } else { plan.conflicts.push({ id, local: mine, remote: theirs, fields: [] }); continue; }
      if (chosen) { plan.cards.push(chosen); plan.deleted.delete(id); }
      else plan.deleted.add(id);
    }
    return plan;
  }
  function acceptMerge(plan, choices = []) {
    const cards = [...plan.cards]; const deleted = new Set(plan.deleted);
    plan.conflicts.forEach((conflict, index) => {
      const source = choices[index] === "local" ? conflict.local : conflict.remote;
      const card = conflict.fields.length ? { ...conflict.merged } : source;
      if (conflict.fields.length) conflict.fields.forEach(field => { card[field] = source[field]; });
      if (card) { cards.push(card); deleted.delete(conflict.id); } else deleted.add(conflict.id);
    });
    if (choices.length) {
      const key = `${outboxScope()}${TAB_ID}`;
      localStorage.setItem(key, JSON.stringify({ baseCards: plan.payload.cards, baseDeleted: plan.payload.deletedCardIds, cards, deletedCardIds: [...deleted], savedAt: Date.now() }));
      for (const [ackKey, raw] of journalAcks) if (ackKey !== key && localStorage.getItem(ackKey) === raw) localStorage.removeItem(ackKey);
      if (plan.journal && plan.journal.key !== key && localStorage.getItem(plan.journal.key) === plan.journal.raw) localStorage.removeItem(plan.journal.key);
      journalAcks.clear();
    }
    if (!plan.localOnly) setServerBase(plan.payload);
    if (plan.journal) journalAcks.set(plan.journal.key, plan.journal.raw);
    replaceLibrary(cards, deleted);
    syncDirty = plan.localOnly || fingerprint(state.cards, deletedCardIds) !== fingerprint(serverBaseCards, serverBaseDeleted);
    conflictPlan = null;
    persistSyncMeta();
  }
  function renderStorageNotice() {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("java-interview-local-notice-dismissed") === "1"; } catch {}
    els.localStorageNotice.classList.toggle("hidden", location.protocol !== "file:" || dismissed);
  }
  function syncResponsiveDisclosures() {
    // The drawer controls visibility on small screens; its filters remain expanded.
    document.getElementById("filterDetails").open = true;
  }
  function cardKey(card) { return `${card.category}\u0000${card.question}`; }
  function hasDamagedText(card) { return [card.category, card.question, card.briefAnswer, card.detailedAnswer].some((text) => String(text || "").includes("\uFFFD")); }
  function mergeCardCollections(primary, secondary) {
    const merged = primary.map(normalizeCard).filter(card => !deletedCardIds.has(card.id));
    secondary.map(normalizeCard).filter(card => !deletedCardIds.has(card.id)).forEach((incoming) => {
      const index = merged.findIndex((card) => card.id === incoming.id || cardKey(card) === cardKey(incoming));
      if (index < 0) { merged.push(incoming); return; }
      const current = merged[index];
      merged[index] = { ...current, ...incoming, id: current.id, proficiency: current.proficiency, starred: current.starred };
      for (const field of ["category", "question", "briefAnswer", "detailedAnswer"]) {
        if (String(incoming[field]).includes("\uFFFD") && !String(current[field]).includes("\uFFFD")) merged[index][field] = current[field];
      }
    });
    return merged;
  }
  function scheduleServerSave() {
    if (!isLocalCardServer()) return;
    if (!serverStorageLoaded) { serverSavePending = true; setSyncStatus("error", "已暂存浏览器，连接电脑后再同步"); return; }
    if (conflictPlan) { setSyncStatus("conflict", "修改有冲突，请核对后同步"); return; }
    setSyncStatus("pending", "已暂存浏览器，等待同步…");
    clearTimeout(scheduleServerSave.timer);
    scheduleServerSave.timer = setTimeout(writeCardsToDisk, 350);
  }
  async function writeCardsToDisk() {
    if (!isLocalCardServer()) return true;
    const write = async () => {
      if (!serverStorageLoaded || conflictPlan) return false;
      try {
        captureInitialPending();
        const selectedId = state.activeId; const selectedStage = state.revealStage;
        // Read the confirmed base first; replay per-tab deltas instead of re-sending stale acknowledged edits.
        const latestResponse = await libraryRequest({ cache: "no-store" });
        const latest = await latestResponse.json();
        if (!latestResponse.ok || !validServerLibrary(latest)) throw new Error("无法读取最新题库，已暂停写入并保留待同步记录");
        journalAcks.clear();
        setServerBase(latest); replaceLibrary(latest.cards, latest.deletedCardIds); syncDirty = false;
        if (!mergePendingTabs()) return false;
        if (filteredCards().some(card => card.id === selectedId)) { state.activeId = selectedId; state.revealStage = selectedStage; render(); }
        for (let attempt = 0; attempt < 3; attempt++) {
          const snapshot = state.cards.map(normalizeCard); const deletedSnapshot = [...deletedCardIds];
          setSyncStatus("saving", "正在同步到电脑…");
          const response = await libraryRequest({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards: snapshot, deletedCardIds: deletedSnapshot, baseRevision: serverRevision }) });
          const payload = await response.json();
          if (response.status === 409 && validServerLibrary(payload)) {
            const plan = buildMergePlan(payload);
            if (plan.conflicts.length) {
              conflictPlan = plan; syncDirty = true; persistSyncMeta();
              setSyncStatus("conflict", `${plan.conflicts.length} 张卡片有冲突，请核对修改`);
              return false;
            }
            acceptMerge(plan);
            continue;
          }
          if (!response.ok || payload.syncVersion !== 2 || typeof payload.revision !== "string") throw new Error(payload.error || (cloudConfig ? "云端同步暂不可用，请稍后重试" : "请重启电脑端服务后重试"));
          setServerBase({ cards: snapshot, deletedCardIds: deletedSnapshot, revision: payload.revision });
          acknowledgeJournals();
          syncDirty = fingerprint(state.cards, deletedCardIds) !== fingerprint(snapshot, deletedSnapshot);
          if (journals().length) syncDirty = true;
          persistSyncMeta();
          setSyncStatus(syncDirty ? "pending" : "saved", syncDirty ? "还有修改等待同步…" : "已同步到电脑");
          if (syncDirty) scheduleServerSave();
          return true;
        }
        throw new Error("其他设备正在更新，请稍后重试");
      } catch (error) {
        syncDirty = true;
        setSyncStatus("error", error.name === "AbortError" ? "连接超时，修改已暂存浏览器" : `未同步：${error.message}`);
        console.warn("本机卡片文件保存失败：", error);
        return false;
      }
    };
    const coordinated = () => navigator.locks ? navigator.locks.request(`interview-sync:${cloudConfig ? "cloud" : "local"}`, write) : write();
    serverWriteQueue = serverWriteQueue.then(coordinated, coordinated);
    return serverWriteQueue;
  }
  async function loadCardsFromDisk() {
    if (!isLocalCardServer()) return;
    try {
      captureInitialPending();
      if (!mergePendingTabs()) return true;
      setSyncStatus("checking", "正在读取电脑题库…");
      const response = await libraryRequest({ cache: "no-store" });
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw new Error(problem.error || "读取失败"); }
      const payload = await response.json();
      if (!validServerLibrary(payload)) throw new Error(cloudConfig ? "云端同步服务暂不可用" : "请重启电脑端服务，启用新版同步");
      if (!payload.exists) {
        setServerBase(payload); syncDirty = state.cards.length > 0; persistSyncMeta();
      } else if (syncDirty || (!serverRevision && state.cards.length > 0)) {
        // A browser cache with no known base must be reviewed before it replaces disk content.
        if (!serverRevision) state.cards = state.cards.filter(card => !payload.deletedCardIds.includes(card.id));
        const plan = buildMergePlan(payload);
        serverStorageLoaded = true; serverFileExists = true;
        if (plan.conflicts.length) {
          conflictPlan = plan; syncDirty = true; persistSyncMeta();
          setSyncStatus("conflict", `${plan.conflicts.length} 张卡片有冲突，请核对修改`);
          return true;
        }
        acceptMerge(plan);
      } else {
        setServerBase(payload); replaceLibrary(payload.cards, payload.deletedCardIds); syncDirty = false; persistSyncMeta();
      }
      if (!syncDirty) acknowledgeJournals();
      setSyncStatus(syncDirty ? "pending" : "saved", syncDirty ? "本设备有修改等待同步" : "已同步到电脑");
      return true;
    } catch (error) {
      serverStorageLoaded = false;
      setSyncStatus("error", `电脑题库未读取：${error.message}；已暂停写入`);
      console.warn("本机卡片文件不可用，将继续使用浏览器本地数据：", error);
      return false;
    }
  }
  async function loadInitialCards() {
    if (location.protocol === "file:") return;
    if (cloudConfig) return;
    if (serverAvailable && serverStorageLoaded && serverFileExists) return;
    try {
      const response = await fetch("initial-cards.json", { cache: "no-store" });
      if (!response.ok) throw new Error("读取初始卡片失败");
      const payload = await response.json();
      const initialCards = Array.isArray(payload.cards) ? payload.cards : [];
      const revision = String(payload.contentVersion || payload.savedAt || "initial");
      if (localStorage.getItem(INITIAL_CARDS_KEY) === revision && state.cards.length && !state.cards.some(hasDamagedText)) return;
      if (isLocalCardServer()) {
        // Initial content only seeds missing cards or repairs damaged fields locally.
        // Existing local edits, including category changes, are authoritative.
        for (const incoming of initialCards.map(normalizeCard)) {
          if (deletedCardIds.has(incoming.id)) continue;
          const existing = state.cards.find(card => card.id === incoming.id || cardKey(card) === cardKey(incoming));
          if (!existing) { state.cards.push(incoming); continue; }
          for (const field of ["category", "question", "briefAnswer", "detailedAnswer"]) {
            if (String(existing[field]).includes("\uFFFD") && !String(incoming[field]).includes("\uFFFD")) existing[field] = incoming[field];
          }
        }
      } else state.cards = mergeCardCollections(state.cards, initialCards);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
      localStorage.setItem(INITIAL_CARDS_KEY, revision);
      render();
    } catch (error) {
      console.warn("初始卡片加载失败：", error);
    }
  }

  function loadCards() {
    const saved = readJson(STORAGE_KEY, []);
    const currentCards = Array.isArray(saved) ? saved.map(normalizeCard).filter(card => !deletedCardIds.has(card.id)) : [];
    const legacyPayload = readJson(LEGACY_KEY, []);
    const legacyCards = (Array.isArray(legacyPayload) ? legacyPayload : legacyPayload.cards || []).map(legacyCardToSimple).filter((card) => card.question || card.briefAnswer || card.detailedAnswer);
    const merged = [...currentCards];
    legacyCards.forEach((legacyCard) => {
      if (deletedCardIds.has(legacyCard.id)) return;
      const existingIndex = merged.findIndex((card) => card.id === legacyCard.id || (card.category === legacyCard.category && card.question === legacyCard.question));
      if (existingIndex < 0) { merged.push(legacyCard); recoveredLegacyCards++; return; }
      const existing = merged[existingIndex];
      if (legacyCard.briefAnswer !== existing.briefAnswer || legacyCard.detailedAnswer.length > existing.detailedAnswer.length) refreshedLegacyCards++;
      merged[existingIndex] = {
        ...existing,
        briefAnswer: existing.briefAnswer || legacyCard.briefAnswer,
        detailedAnswer: existing.detailedAnswer || legacyCard.detailedAnswer,
        proficiency: existing.proficiency || legacyCard.proficiency
      };
    });
    if (recoveredLegacyCards || refreshedLegacyCards || !Array.isArray(saved)) localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return merged;
  }
  function legacyCardToSimple(card) {
    return normalizeCard({
      id: card.id,
      category: card.category || card.module || "未分类",
      proficiency: card.proficiency || legacyProficiency(card),
      starred: Boolean(card.starred),
      question: card.question || card.title || "",
      briefAnswer: card.briefAnswer || card.shortAnswer || "",
      detailedAnswer: card.detailedAnswer || card.interviewAnswer || card.details || card.answer || card.shortAnswer || ""
    });
  }
  function legacyProficiency(card) { const status = readJson("java-interview-progress:v1", {})[card.id]?.status; return status === "mastered" ? "熟练" : status === "good" ? "一般" : "生疏"; }
  function normalizeCard(card) {
    const legacyAnswer = String(card.answer || "").trim();
    const detailedAnswer = String(card.detailedAnswer || legacyAnswer).trim();
    return { id: card.id || createId(), category: String(card.category || "未分类").trim(), proficiency: PROFICIENCY.includes(card.proficiency) ? card.proficiency : "生疏", starred: Boolean(card.starred), question: String(card.question || "").trim(), briefAnswer: String(card.briefAnswer || conciseAnswer(legacyAnswer || detailedAnswer)).trim(), detailedAnswer };
  }
  function categories() { return [...new Set([...DEFAULT_CATEGORIES, ...state.cards.map((card) => card.category).filter(Boolean)])]; }
  function filteredCards() {
    const query = state.query.trim().toLowerCase();
    return state.cards.filter((card) => (!state.starredOnly || card.starred) && (state.proficiency === "全部" || card.proficiency === state.proficiency) && (state.category === "全部" || card.category === state.category) && (!query || [card.category, card.question, card.briefAnswer, card.detailedAnswer, card.proficiency].join(" ").toLowerCase().includes(query))).sort((a, b) => proficiencyIndex(a.proficiency) - proficiencyIndex(b.proficiency));
  }
  function activeCard() { return state.cards.find((card) => card.id === state.activeId); }
  function hasDetailedAnswer(card) { return Boolean(card?.detailedAnswer?.trim()); }
  function chooseActive() {
    const cards = filteredCards();
    if (!cards.some((card) => card.id === state.activeId)) {
      state.activeId = cards[0]?.id || null;
      state.revealStage = 0;
    }
  }

  function render() { chooseActive(); renderCategories(); renderStarredFilter(); renderCard(); renderList(); renderStats(); rememberView(); document.getElementById("undoRatingButton").disabled = !undoRatings.length || state.loading; }
  function renderCategories() {
    const values = ["全部", ...categories().filter((category) => state.cards.some((card) => card.category === category))];
    els.categoryFilters.innerHTML = values.map((category) => `<button class="tag-button ${state.category === category ? "active" : ""}" data-category="${escapeHtml(category)}" type="button" aria-pressed="${state.category === category}">${escapeHtml(category)}</button>`).join("");
    els.categoryFilters.querySelectorAll("button").forEach((button) => button.onclick = () => { state.category = button.dataset.category; state.revealStage = 0; render(); });
  }
  function renderStarredFilter() {
    const count = state.cards.filter((card) => card.starred).length;
    els.starredFilterButton.textContent = `★ 重点集 (${count})`;
    els.starredFilterButton.classList.toggle("active", state.starredOnly);
    els.starredFilterButton.setAttribute("aria-pressed", String(state.starredOnly));
    els.allCardsButton.classList.toggle("active", !state.starredOnly);
    els.allCardsButton.setAttribute("aria-pressed", String(!state.starredOnly));
  }
  function renderCard() {
    const card = activeCard(); const hasCard = Boolean(card);
    if (editCurrentCardButton) editCurrentCardButton.disabled = !hasCard || state.loading;
    if (newCardButton) newCardButton.disabled = state.loading;
    if (!hasCard || state.revealStage === 0) setReadingExpanded(false, true);
    const visibleCards = filteredCards();
    const position = visibleCards.findIndex((item) => item.id === card?.id) + 1;
    els.collectionTitle.textContent = state.starredOnly ? `重点集${state.category !== "全部" ? ` / ${state.category}` : ""}` : state.category === "全部" ? "全部卡片" : state.category;
    els.cardPosition.textContent = hasCard ? `第 ${position} / ${visibleCards.length} 张` : "暂无符合条件的卡片";
    els.previousCardButton.disabled = !hasCard;
    els.nextCardButton.disabled = !hasCard;
    const viewKey = `${card?.id || "empty"}:${state.revealStage}`;
    if (els.flashcard.dataset.viewKey !== viewKey) {
      els.flashcard.scrollTop = 0;
      els.cardQuestionBack.classList.remove("question-expanded");
      document.getElementById("expandQuestionButton").setAttribute("aria-expanded", "false");
      document.getElementById("expandQuestionButton").textContent = "展开完整题目";
    }
    els.flashcard.dataset.viewKey = viewKey;
    els.flashcard.classList.toggle("flipped", state.revealStage > 0); els.flashcard.dataset.proficiency = card?.proficiency || "生疏"; els.flashcard.dataset.revealStage = state.revealStage; els.flipButton.disabled = !hasCard;
    document.getElementById("ratingToggleButton").disabled = !hasCard;
    [els.starToggleButton, els.starToggleButtonBack].forEach((button) => {
      button.disabled = !hasCard;
      button.classList.toggle("is-starred", Boolean(card?.starred));
      button.setAttribute("aria-pressed", String(Boolean(card?.starred)));
      button.setAttribute("aria-label", card?.starred ? "从重点集中移除" : "加入重点集");
      button.querySelector("span").textContent = card?.starred ? "★" : "☆";
    });
    [[els.weakButton, "生疏"], [els.normalButton, "一般"], [els.masteredButton, "熟练"]].forEach(([button, value]) => {
      button.disabled = !hasCard;
      button.setAttribute("aria-pressed", String(hasCard && card.proficiency === value));
    });
    if (!card) {
      els.flipButton.textContent = "查看答案";
      els.cardCategory.textContent = "未分类"; els.cardProficiency.textContent = "生疏";
      els.cardCategoryBack.textContent = "未分类"; els.cardProficiencyBack.textContent = "生疏";
      els.cardAnswerLabel.textContent = "精简答案";
      els.cardQuestion.textContent = state.loading ? "加载卡片中……" : state.starredOnly ? "这里还没有符合条件的重点卡片" : "没有找到匹配的卡片";
      els.cardQuestionBack.textContent = els.cardQuestion.textContent;
      els.cardFlipTip.textContent = state.loading ? "稍等片刻，正在整理题目。" : !state.cards.length && newCardButton ? "点击页面顶部“新增卡片”，添加第一张题目。" : state.starredOnly ? "回到全部卡片，点 ☆ 标记重点；也可以调整分类或搜索。" : "试试其他关键词，或切换到全部分类。";
      els.cardAnswer.textContent = els.cardFlipTip.textContent;
      els.showDetailedButton.classList.add("hidden"); els.showDetailedButton.disabled = true; return;
    }
    els.cardCategory.textContent = card.category; els.cardCategoryBack.textContent = card.category; els.cardProficiency.textContent = card.proficiency; els.cardProficiencyBack.textContent = card.proficiency; els.cardQuestion.textContent = card.question;
    els.cardQuestionBack.textContent = card.question;
    requestAnimationFrame(updateQuestionToggle);
    const hasDetailed = hasDetailedAnswer(card);
    els.cardAnswerLabel.textContent = state.revealStage === 2 && hasDetailed ? "详细答案" : "精简答案"; els.cardAnswer.innerHTML = formatText(state.revealStage === 2 && hasDetailed ? card.detailedAnswer : card.briefAnswer);
    els.showDetailedButton.classList.toggle("hidden", !(state.revealStage === 1 && hasDetailed)); els.showDetailedButton.disabled = !hasDetailed;
    els.flipButton.textContent = state.revealStage === 0 ? "查看精简答案" : "查看题面";
    els.cardFlipTip.textContent = "点击卡片或下方按钮查看答案";
  }
  function renderList() {
    const cards = filteredCards(); els.cardCount.textContent = `${cards.length} 张题目`;
    els.cardList.innerHTML = cards.map((card) => `<button class="simple-list-card ${card.id === state.activeId ? "active" : ""}" aria-current="${card.id === state.activeId}" data-proficiency="${escapeHtml(card.proficiency)}" data-starred="${card.starred}" data-id="${escapeHtml(card.id)}" type="button"><span>${escapeHtml(card.category)}</span><strong>${escapeHtml(card.question)}</strong><small>${escapeHtml(card.proficiency)}</small></button>`).join("") || `<p class="note">${state.starredOnly ? "重点集还是空的，点卡片右上角☆标记重点。" : "没有符合条件的卡片。"}</p>`;
    els.cardList.querySelectorAll("button").forEach((button) => button.onclick = () => { state.activeId = button.dataset.id; state.revealStage = 0; render(); if (sidebarMedia.matches) setSidebarCollapsed(true, true); });
    const selected = els.cardList.querySelector('[aria-current="true"]');
    if (selected && els.cardList.clientHeight > 0) {
      const listBounds = els.cardList.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      if (selectedBounds.top < listBounds.top) els.cardList.scrollTop += selectedBounds.top - listBounds.top;
      else if (selectedBounds.bottom > listBounds.bottom) els.cardList.scrollTop += selectedBounds.bottom - listBounds.bottom;
    }
  }
  function renderStats() {
    const cards = filteredCards();
    const weakCards = cards.filter(c => c.proficiency === "生疏");
    const normalCards = cards.filter(c => c.proficiency === "一般");
    const masteredCards = cards.filter(c => c.proficiency === "熟练");

    els.totalCount.textContent = cards.length;
    els.weakCount.textContent = weakCards.length;
    els.normalCount.textContent = normalCards.length;
    els.masteredCount.textContent = masteredCards.length;
    const mastery = cards.length ? Math.round(masteredCards.length / cards.length * 100) : 0;
    els.masteryPercentage.textContent = `${mastery}%`;
    els.masteryMeter.setAttribute("aria-valuenow", String(mastery));
    els.masteryFill.style.width = `${mastery}%`;

    if (weakCards.length > 0) {
      els.studyTip.textContent = `当前有 ${weakCards.length} 张生疏卡片，建议优先复习。`;
    } else if (normalCards.length > 0) {
      els.studyTip.textContent = `生疏卡片已清空！继续巩固 ${normalCards.length} 张一般卡片。`;
    } else if (masteredCards.length === cards.length && cards.length > 0) {
      els.studyTip.textContent = `🎉 所有卡片都已熟练掌握！`;
    } else {
      els.studyTip.textContent = `开始复习吧！`;
    }
  }

  function updateProficiency(proficiency) {
    const card = activeCard(); if (!card || state.loading) return;
    const cards = filteredCards(); const index = cards.findIndex((item) => item.id === card.id); const nextId = cards.length > 1 ? cards[(index + 1) % cards.length].id : card.id;
    const previous = card.proficiency;
    card.proficiency = proficiency;
    try { saveCards(); } catch { card.proficiency = previous; showToast("浏览器保存失败，请先导出完整题库备份"); return; }
    if (previous !== proficiency) {
      undoRatings.push({ id: card.id, previous, next: proficiency }); undoRatings = undoRatings.slice(-10);
      try { sessionStorage.setItem("interview-rating-undo:v1", JSON.stringify(undoRatings)); } catch {}
    }
    state.activeId = nextId; state.revealStage = 0; render(); showToast(`已标记为"${proficiency}"，已进入下一张`);
  }
  function flip() {
    if (!activeCard()) return;
    state.revealStage = state.revealStage === 0 ? 1 : 0;
    renderCard();
  }
  function showDetailedAnswer() {
    if (!hasDetailedAnswer(activeCard())) return;
    state.revealStage = 2;
    renderCard();
  }
  function moveCard(direction) { const cards = filteredCards(); if (!cards.length) return; const index = Math.max(0, cards.findIndex((card) => card.id === state.activeId)); state.activeId = cards[(index + direction + cards.length) % cards.length].id; state.revealStage = 0; render(); }

  function toggleStar() {
    const card = activeCard(); if (!card || state.loading) return;
    card.starred = !card.starred;
    try { saveCards(); } catch { card.starred = !card.starred; showToast("浏览器保存失败，请先导出完整题库备份"); return; }
    render();
    showToast(card.starred ? "已加入重点集" : "已从重点集移除");
  }
  function exportProgress() {
    const backup = {
      format: "java-interview-flashcards-progress",
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: state.cards.map((card) => ({ id: card.id, category: card.category, question: card.question, proficiency: card.proficiency, starred: Boolean(card.starred) }))
    };
    downloadBackup(backup, "八股卡片进度");
    showToast("进度备份已导出");
  }
  function downloadBackup(backup, name) {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportLibrary() {
    downloadBackup({ format: "java-interview-flashcards-library", version: 1, exportedAt: new Date().toISOString(), cards: state.cards.map(normalizeCard), deletedCardIds: [...deletedCardIds] }, "八股卡片完整题库");
    showToast("完整题库已导出，包含答案与学习进度");
  }
  function importLibrary(backup) {
    if (backup.version !== 1 || !Array.isArray(backup.cards) || !Array.isArray(backup.deletedCardIds) || backup.deletedCardIds.some(id => typeof id !== "string")) throw new Error("完整题库备份格式不正确。");
    const ids = new Set();
    for (const card of backup.cards) {
      if (!card || typeof card.id !== "string" || !card.id.trim() || ids.has(card.id) || typeof card.category !== "string" || !card.category.trim() || typeof card.question !== "string" || !card.question.trim() || typeof card.briefAnswer !== "string" || typeof card.detailedAnswer !== "string" || !PROFICIENCY.includes(card.proficiency) || typeof card.starred !== "boolean") throw new Error("备份含有无效或重复的卡片，请检查文件。");
      ids.add(card.id);
    }
    const incoming = backup.cards.map(normalizeCard);
    const existing = new Map(state.cards.map(card => [card.id, card]));
    const additions = incoming.filter(card => !existing.has(card.id)).length;
    if (backup.deletedCardIds.some(id => ids.has(id))) throw new Error("备份中同一卡片同时存在于题库和删除记录，未导入。");
    const deletions = backup.deletedCardIds.filter(id => existing.has(id)).length;
    if (!confirm(`导入完整题库：新增 ${additions} 张，更新 ${incoming.length - additions} 张，按备份中的删除记录移除 ${deletions} 张。\n同 ID 卡片的题面、答案、熟练度和星标将使用备份内容，其他现有卡片保留。`)) return;
    const previous = state.cards; const previousDeleted = [...deletedCardIds];
    incoming.forEach(card => { existing.set(card.id, card); deletedCardIds.delete(card.id); });
    backup.deletedCardIds.forEach(id => { existing.delete(id); deletedCardIds.add(id); });
    state.cards = [...existing.values()];
    try { saveCards(); }
    catch (error) { state.cards = previous; deletedCardIds.clear(); previousDeleted.forEach(id => deletedCardIds.add(id)); render(); throw error; }
    state.revealStage = 0;
    if (incoming[0]) keepEditedCardVisible(incoming[0]);
    render(); showToast(`已导入 ${incoming.length} 张完整卡片${deletions ? `，恢复 ${deletions} 条删除记录` : ""}`);
  }
  async function importProgress(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (state.loading) throw new Error("请等待题库加载完成后导入。");
      if (backup?.format === "java-interview-flashcards-library") { importLibrary(backup); return; }
      if (backup?.format !== "java-interview-flashcards-progress" || backup.version !== 1 || !Array.isArray(backup.cards)) {
        throw new Error("备份格式不受支持。");
      }
      let restored = 0;
      let skipped = 0;
      const previous = state.cards;
      const candidate = previous.map(card => ({ ...card }));
      const byId = new Map(candidate.map((card) => [card.id, card]));
      const seen = new Set();
      for (const entry of backup.cards) {
        if (!entry || typeof entry.category !== "string" || typeof entry.question !== "string" || !PROFICIENCY.includes(entry.proficiency) || typeof entry.starred !== "boolean") {
          skipped++;
          continue;
        }
        const key = cardKey({ category: entry.category.trim(), question: entry.question.trim() });
        const card = (typeof entry.id === "string" ? byId.get(entry.id) : null) || candidate.find((item) => cardKey(item) === key);
        if (!card || seen.has(card.id)) { skipped++; continue; }
        seen.add(card.id);
        card.proficiency = entry.proficiency;
        card.starred = entry.starred;
        restored++;
      }
      if (restored) {
        const changed = candidate.filter((card, i) => card.proficiency !== previous[i].proficiency || card.starred !== previous[i].starred).length;
        if (!confirm(`匹配 ${restored} 张卡片，将更新 ${changed} 张的熟练度或收藏，跳过 ${skipped} 条。\n匹配卡片的标记会使用备份内容，题目与答案保持原样。继续导入吗？`)) return;
        state.cards = candidate;
        try { saveCards(); } catch (error) { state.cards = previous; render(); throw error; }
        render();
      }
      showToast(restored ? `已恢复 ${restored} 张卡片的进度${skipped ? `，跳过 ${skipped} 张` : ""}` : "没有匹配到可恢复的卡片");
    } catch (error) {
      showToast(error.message || "无法读取这个进度备份");
    } finally {
      els.progressFileInput.value = "";
    }
  }

  function editorValues() {
    const values = Object.fromEntries(["category", "proficiency", "question", "briefAnswer", "detailedAnswer"].map(name => [name, cardEditorForm.elements[name].value]));
    if (values.category === NEW_EDITOR_CATEGORY) values.category = cardEditorForm.elements.newCategory.value;
    return values;
  }
  function syncEditorCategoryField() {
    const isNew = editorCategorySelect.value === NEW_EDITOR_CATEGORY;
    editorNewCategoryField.classList.toggle("hidden", !isNew);
    cardEditorForm.elements.newCategory.required = isNew;
    cardEditorForm.elements.newCategory.setCustomValidity("");
  }
  function fillCardEditor(card) {
    editorCategorySelect.innerHTML = categories().map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("") + `<option value="${NEW_EDITOR_CATEGORY}">＋ 新建分类</option>`;
    for (const name of ["category", "proficiency", "question", "briefAnswer", "detailedAnswer"]) {
      cardEditorForm.elements[name].value = card[name];
      cardEditorForm.elements[name].setCustomValidity("");
    }
    cardEditorForm.elements.newCategory.value = "";
    syncEditorCategoryField();
    editorOriginalValues = JSON.stringify(editorValues());
  }
  editorCategorySelect.onchange = () => {
    syncEditorCategoryField();
    if (editorCategorySelect.value === NEW_EDITOR_CATEGORY) cardEditorForm.elements.newCategory.focus();
  };
  function keepEditedCardVisible(card) {
    state.activeId = card.id;
    if (state.category !== "全部" && state.category !== card.category) state.category = card.category;
    if (!filteredCards().some(item => item.id === card.id)) { state.query = ""; els.searchInput.value = ""; }
    if (state.proficiency !== "全部" && state.proficiency !== card.proficiency) { state.proficiency = "全部"; document.getElementById("proficiencyFilter").value = "全部"; }
  }
  function editorHasChanges() { return JSON.stringify(editorValues()) !== editorOriginalValues; }
  function openCardEditor(mode = "edit") {
    if (state.loading || editorSaving || cardEditorDialog.open) return;
    const card = mode === "new" ? {
      category: state.category !== "全部" ? state.category : activeCard()?.category || DEFAULT_CATEGORIES[0],
      proficiency: "生疏", question: "", briefAnswer: "", detailedAnswer: ""
    } : activeCard();
    if (!card) return;
    editorMode = mode;
    editingCardId = mode === "new" ? null : card.id;
    newCardStarred = state.starredOnly;
    pendingDeletion = false;
    document.getElementById("cardEditorTitle").textContent = mode === "new" ? "新增卡片" : "编辑当前卡片";
    document.getElementById("cardEditorDescription").textContent = mode === "new" ? (newCardStarred ? "保存后显示新卡片，并自动加入当前重点集。" : "保存后直接显示新卡片，开始复习。") : "保存后留在当前卡片，继续复习。";
    cardEditorForm.querySelector('[type="submit"]').textContent = mode === "new" ? "新增卡片" : "保存修改";
    deleteCurrentCardButton.classList.toggle("hidden", mode === "new");
    deleteCurrentCardButton.textContent = "删除卡片";
    fillCardEditor(card);
    cardEditorStatus.textContent = "";
    document.body.classList.add("editor-open");
    cardEditorDialog.showModal();
    cardEditorForm.elements.question.focus({ preventScroll: true });
  }
  function closeCardEditor() {
    if (editorSaving) return;
    if (pendingDeletion) {
      if (!confirm(`删除已保存在浏览器，但${cloudConfig ? "云端" : "本机文件"}尚未同步。关闭后将在下次加载时重试，仍要关闭吗？`)) return;
    } else if (editorHasChanges() && !confirm("当前有未保存的修改，确定放弃吗？")) return;
    cardEditorDialog.close();
  }
  editCurrentCardButton?.addEventListener("click", () => openCardEditor());
  newCardButton?.addEventListener("click", () => openCardEditor("new"));
  document.getElementById("closeCardEditorButton").onclick = closeCardEditor;
  document.getElementById("cancelCardEditorButton").onclick = closeCardEditor;
  cardEditorDialog.addEventListener("cancel", event => { event.preventDefault(); closeCardEditor(); });
  cardEditorDialog.addEventListener("close", () => {
    document.body.classList.remove("editor-open");
    editingCardId = null;
    pendingDeletion = false;
    setEditorBusy(false);
    cardEditorForm.reset();
    cardEditorStatus.textContent = "";
  });
  cardEditorForm.addEventListener("input", event => { event.target.setCustomValidity?.(""); cardEditorStatus.textContent = ""; });
  cardEditorForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (editorSaving || pendingDeletion) return;
    const values = editorValues();
    for (const name of ["category", "question", "briefAnswer", "detailedAnswer"]) values[name] = values[name].trim();
    for (const [name, label] of [["category", "分类"], ["question", "题面"], ["briefAnswer", "精简答案"]]) {
      if (!values[name]) {
        const field = name === "category" && editorCategorySelect.value === NEW_EDITOR_CATEGORY ? cardEditorForm.elements.newCategory : cardEditorForm.elements[name];
        field.setCustomValidity(`请填写${label}。`); field.reportValidity(); return;
      }
    }
    const index = state.cards.findIndex(card => card.id === editingCardId);
    const isNew = editorMode === "new" && editingCardId === null;
    if (!isNew && (index < 0 || deletedCardIds.has(editingCardId))) { cardEditorStatus.textContent = "这张卡片已不存在，请关闭编辑后重新选择。"; return; }
    const duplicate = state.cards.some(card => card.id !== editingCardId && card.category === values.category && card.question === values.question);
    if (duplicate && !confirm("该分类下已有相同题面，仍要保存吗？")) return;
    const previous = state.cards[index];
    const updated = isNew ? { ...values, id: createId(), starred: newCardStarred } : { ...previous, ...values };
    if (isNew) state.cards.push(updated);
    else state.cards[index] = updated;
    try { saveCards(); }
    catch {
      if (isNew) state.cards.pop(); else state.cards[index] = previous;
      cardEditorStatus.textContent = "保存失败，请检查浏览器存储空间后重试。"; return;
    }
    editingCardId = updated.id;
    keepEditedCardVisible(updated);
    if (isNew) state.revealStage = 0;
    if (state.revealStage === 2 && !values.detailedAnswer) state.revealStage = 1;
    render();
    editorOriginalValues = JSON.stringify(editorValues());
    setEditorBusy(true);
    const saveButton = cardEditorForm.querySelector('[type="submit"]');
    saveButton.textContent = "保存中…";
    try {
      if (isLocalCardServer()) {
        clearTimeout(scheduleServerSave.timer);
        if (!await writeCardsToDisk()) { cardEditorStatus.textContent = conflictPlan ? "已保存到浏览器。请关闭编辑窗口，点击同步状态旁的“核对修改”。" : "已保存到浏览器，但未同步到电脑。可重试保存，或关闭后点击“重试同步”。"; return; }
      }
      cardEditorDialog.close();
      showToast(editorMode === "new" ? "卡片已新增" : "卡片已更新");
    } finally {
      setEditorBusy(false);
      saveButton.textContent = editorMode === "new" ? "新增卡片" : "保存修改";
    }
  });
  function setEditorBusy(busy) {
    editorSaving = busy;
    cardEditorForm.querySelectorAll("input, select, textarea, button").forEach(control => {
      control.disabled = busy || (pendingDeletion && (control.matches("input, select, textarea") || control.type === "submit"));
    });
    cardEditorDialog.setAttribute("aria-busy", String(busy));
    if (cloudConfig) cardEditorStatus.textContent = cardEditorStatus.textContent.replaceAll("电脑", "云端").replaceAll("本机文件", "云端题库");
  }
  deleteCurrentCardButton.addEventListener("click", async () => {
    if (editorSaving || editorMode !== "edit") return;
    if (!pendingDeletion) {
      const card = state.cards.find(item => item.id === editingCardId);
      if (!card) { cardEditorStatus.textContent = "这张卡片已不存在，请关闭窗口重新选择。"; return; }
      if (!confirm(`确定删除这张卡片吗？\n\n${card.question}\n\n该卡片的熟练度和星标也会一并删除。`)) return;
      const visible = filteredCards();
      const position = visible.findIndex(item => item.id === card.id);
      const nextId = visible[position + 1]?.id || visible[position - 1]?.id || null;
      const previousCards = state.cards;
      state.cards = state.cards.filter(item => item.id !== card.id);
      deletedCardIds.add(card.id);
      try { saveCards(); }
      catch {
        state.cards = previousCards; deletedCardIds.delete(card.id);
        try { localStorage.setItem(DELETED_CARDS_KEY, JSON.stringify([...deletedCardIds])); } catch {}
        cardEditorStatus.textContent = "删除失败，请检查浏览器存储空间后重试。"; return;
      }
      pendingDeletion = true;
      state.activeId = nextId;
      state.revealStage = 0;
      if (state.category !== "全部" && !state.cards.some(item => item.category === state.category)) state.category = "全部";
      render();
    }
    setEditorBusy(true);
    deleteCurrentCardButton.textContent = "删除中…";
    try {
      clearTimeout(scheduleServerSave.timer);
      if (isLocalCardServer() && !await writeCardsToDisk()) {
        cardEditorStatus.textContent = conflictPlan ? "删除已暂存在浏览器。请关闭窗口后点击“核对修改”，核对另一设备的修改。" : "已从浏览器删除，但本机文件同步失败。请点击“重试同步删除”。";
        return;
      }
      pendingDeletion = false;
      cardEditorDialog.close();
      showToast("卡片已删除");
      (activeCard() ? els.nextCardButton : newCardButton)?.focus({ preventScroll: true });
    } finally {
      setEditorBusy(false);
      deleteCurrentCardButton.textContent = pendingDeletion ? "重试同步删除" : "删除卡片";
    }
  });
  window.addEventListener("beforeunload", event => {
    if (cardEditorDialog.open && (editorSaving || pendingDeletion || editorHasChanges())) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("storage", event => {
    if (serverAvailable && ([STORAGE_KEY, DELETED_CARDS_KEY, SYNC_META_KEY, syncMetaStorageKey].includes(event.key) || event.key?.startsWith(outboxScope()))) {
      if (event.key?.startsWith(outboxScope()) && event.newValue && syncPhase !== "saving" && !conflictPlan) setSyncStatus("pending", "正在接收另一标签页的修改");
      if (!state.loading) setTimeout(pollServer, 250);
      return;
    }
    if (event.key === DELETED_CARDS_KEY) {
      try { const ids = JSON.parse(event.newValue); if (Array.isArray(ids)) ids.filter(id => typeof id === "string").forEach(id => deletedCardIds.add(id)); } catch {}
    }
    if (event.key !== STORAGE_KEY || !event.newValue || editorSaving || state.loading) return;
    let incoming;
    try { incoming = JSON.parse(event.newValue); } catch { return; }
    if (!Array.isArray(incoming)) return;
    const hadDraft = cardEditorDialog.open && editorHasChanges();
    const selectedId = state.activeId;
    state.cards = incoming.map(normalizeCard).filter(card => !deletedCardIds.has(card.id));
    const selected = state.cards.find(card => card.id === selectedId);
    if (selected) keepEditedCardVisible(selected);
    else if (state.category !== "全部" && !state.cards.some(card => card.category === state.category)) state.category = "全部";
    render();
    if (cardEditorDialog.open && editorMode === "edit" && !pendingDeletion) {
      const editing = state.cards.find(card => card.id === editingCardId);
      if (!hadDraft && editing) fillCardEditor(editing);
      else cardEditorStatus.textContent = "另一页面的卡片已更新。当前未保存的修改仍保留，请核对后保存。";
    }
  });

  function updateQuestionToggle() {
    const button = document.getElementById("expandQuestionButton");
    const question = els.cardQuestionBack;
    button.hidden = state.revealStage === 0 || (!question.classList.contains("question-expanded") && question.scrollHeight <= question.clientHeight + 1);
  }
  document.getElementById("expandQuestionButton").onclick = () => {
    const expanded = els.cardQuestionBack.classList.toggle("question-expanded");
    const button = document.getElementById("expandQuestionButton");
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "收起题目" : "展开完整题目";
    updateQuestionToggle();
  };
  window.addEventListener("resize", () => requestAnimationFrame(updateQuestionToggle));

  const syncConflictDialog = document.getElementById("syncConflictDialog");
  const historyDialog = document.getElementById("historyDialog");
  const syncConflictForm = document.getElementById("syncConflictForm");
  function openConflictDialog() {
    if (!conflictPlan) return;
    if (cardEditorDialog.open) { showToast("请先关闭编辑窗口，再核对同步修改"); return; }
    if (conflictPlan.localOnly) {
      const journal = conflictPlan.journal;
      conflictPlan = buildMergePlan({ ...conflictPlan.payload, cards: state.cards, deletedCardIds: [...deletedCardIds] }, { baseCards: journal.data.baseCards, localCards: journal.data.cards, localDeleted: new Set(journal.data.deletedCardIds) });
      conflictPlan.localOnly = true; conflictPlan.journal = journal;
    } else conflictPlan = buildMergePlan(conflictPlan.payload);
    if (!conflictPlan.conflicts.length) { acceptMerge(conflictPlan); void writeCardsToDisk(); return; }
    const describe = card => card ? `分类：${card.category}\n题面：${card.question}\n熟练度：${card.proficiency}；重点：${card.starred ? "是" : "否"}\n\n精简答案：\n${card.briefAnswer}\n\n详细答案：\n${card.detailedAnswer}` : "这张卡片已被删除";
    document.getElementById("syncConflictList").innerHTML = conflictPlan.conflicts.map((conflict, index) => `<fieldset class="sync-conflict-item"><legend>${escapeHtml(conflict.local?.question || conflict.remote?.question)}</legend><details><summary>查看两个版本的完整内容</summary><p><strong>本设备版本</strong>\n${escapeHtml(describe(conflict.local))}</p><p><strong>电脑端最新版本</strong>\n${escapeHtml(describe(conflict.remote))}</p></details><label>保留哪个版本<select name="choice-${index}" required><option value="" selected disabled>请选择</option><option value="local">本设备版本${conflict.local ? "" : "（删除卡片）"}</option><option value="remote">电脑端最新版本${conflict.remote ? "" : "（删除卡片）"}</option></select></label></fieldset>`).join("");
    if (cloudConfig) document.getElementById("syncConflictList").innerHTML = document.getElementById("syncConflictList").innerHTML.replaceAll("电脑端最新版本", "云端最新版本");
    document.getElementById("syncConflictStatus").textContent = "本设备尚未同步的内容会保留到你做出选择；也可以先导出备份。";
    if (!syncConflictDialog.open) syncConflictDialog.showModal();
  }
  document.getElementById("laterConflictButton").onclick = () => syncConflictDialog.close();
  document.getElementById("exportConflictBackupButton").onclick = exportLibrary;
  syncConflictForm.onsubmit = event => {
    event.preventDefault();
    if (!conflictPlan) return;
    const choices = conflictPlan.conflicts.map((_, index) => syncConflictForm.elements[`choice-${index}`].value);
    if (choices.some(choice => !["local", "remote"].includes(choice))) return;
    try {
      acceptMerge(conflictPlan, choices);
      syncConflictDialog.close();
      if (syncDirty) void writeCardsToDisk(); else setSyncStatus("saved", "已同步到电脑");
    } catch (error) { document.getElementById("syncConflictStatus").textContent = `合并未完成：${error.message}，请先导出本设备备份。`; }
  };
  async function pollServer() {
    if (!serverAvailable || state.loading || pollRunning || document.hidden || cardEditorDialog.open || syncConflictDialog.open || historyDialog.open || conflictPlan || syncPhase === "saving") return;
    pollRunning = true;
    try {
      if (!navigator.onLine) { setSyncStatus("offline", "离线，修改已保存在本设备"); return; }
      if (!mergePendingTabs()) return;
      if (!serverStorageLoaded) {
        if (await loadCardsFromDisk() && !conflictPlan && syncDirty) scheduleServerSave();
        return;
      }
      if (syncDirty) { await writeCardsToDisk(); return; }
      const response = await libraryRequest({ cache: "no-store", path: cloudConfig && serverRevision ? `?since=${encodeURIComponent(serverRevision)}` : "" });
      if (!response.ok) throw new Error("无法读取电脑题库");
      const payload = await response.json();
      if (syncDirty || journals().length || cardEditorDialog.open || syncConflictDialog.open || historyDialog.open || syncPhase === "saving") return;
      if (payload.unchanged && payload.revision === serverRevision && payload.syncVersion === 2) { lastSyncAt = Date.now(); setSyncStatus("saved", "已同步"); return; }
      if (!validServerLibrary(payload)) throw new Error("请重启电脑端服务后重新连接");
      if (!payload.exists && serverFileExists) throw new Error("电脑题库文件缺失，请检查文件后重新连接");
      // User input may have happened while the read was in flight.
      if (syncDirty || journals().length || cardEditorDialog.open || syncConflictDialog.open || historyDialog.open || syncPhase === "saving") return;
      if (payload.revision !== serverRevision) {
        setServerBase(payload); replaceLibrary(payload.cards, payload.deletedCardIds); syncDirty = false; persistSyncMeta();
        setSyncStatus("saved", "已接收另一设备的更新");
      }
    } catch (error) {
      serverStorageLoaded = false;
      setSyncStatus("error", "与电脑连接中断，已暂停写入；点击重试同步");
      console.warn("题库更新检查失败：", error);
    } finally { pollRunning = false; }
  }
  document.getElementById("retrySyncButton")?.addEventListener("click", async event => {
    if (conflictPlan) { openConflictDialog(); return; }
    const button = event.currentTarget; button.disabled = true;
    try {
      if (!serverStorageLoaded && !await loadCardsFromDisk()) return;
      if (conflictPlan) { openConflictDialog(); return; }
      if (syncDirty || serverSavePending) { serverSavePending = false; await writeCardsToDisk(); }
      else setSyncStatus("saved", "已同步到电脑");
    } finally { button.disabled = false; }
  });
  const phoneSyncDialog = document.getElementById("phoneSyncDialog");
  document.getElementById("closePhoneSyncButton").onclick = () => phoneSyncDialog.close();
  function renderPrivateLink() {
    const addresses = document.getElementById("phoneSyncAddresses");
    const qr = document.getElementById("privateLinkQr");
    qr.innerHTML = ""; qr.classList.add("hidden");
    if (!cloudConfig) {
      addresses.textContent = localApiOrigin() ? "在这台电脑获取一次专属链接，手机扫码即可关联。" : "请用原专属链接打开，或在下方粘贴链接关联。";
      if (["localhost", "127.0.0.1"].includes(location.hostname)) {
        const button = document.createElement("button"); button.type = "button"; button.className = "private-link-action"; button.textContent = "获取我的专属链接";
        button.onclick = async () => {
          button.disabled = true;
          try {
            const config = await localPrivateConfiguration();
            if (!config) throw new Error("专属链接尚未准备好，请确认电脑端云同步配置已经完成。");
            await connectPrivateConfiguration(config); renderPrivateLink();
          } catch (error) { showToast(error.message); button.disabled = false; }
        };
        addresses.append(document.createElement("br"), button);
      }
      return;
    }
    const link = privateLink();
    addresses.innerHTML = `<label class="phone-sync-address"><span class="sr-only">我的专属同步链接</span><input readonly autocomplete="off" value="${escapeHtml(link)}"><button type="button">复制链接</button></label><a class="private-link-action" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开我的在线复习页</a>`;
    addresses.querySelector("button").onclick = async () => {
        const input = addresses.querySelector("input");
        try {
          if (!navigator.clipboard?.writeText) throw new Error("需要手动复制");
          await navigator.clipboard.writeText(input.value); showToast("专属链接已复制，手机打开一次即可关联");
        } catch { input.select(); showToast("链接已选中，请复制后自己保存"); }
    };
    if (typeof qrcode === "function") {
      const code = qrcode(0, "M"); code.addData(link); code.make();
      qr.innerHTML = code.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
      qr.classList.remove("hidden");
    }
  }
  async function connectPrivateConfiguration(config) {
    clearTimeout(scheduleServerSave.timer);
    await serverWriteQueue;
    const wasLoading = state.loading; state.loading = true; render();
    try {
      selectCloudConfiguration(config);
      const loaded = await loadCardsFromDisk();
      if (loaded && (syncDirty || serverSavePending)) { serverSavePending = false; scheduleServerSave(); }
      return loaded;
    } finally { state.loading = wasLoading; render(); }
  }
  document.getElementById("phoneSyncButton")?.addEventListener("click", () => {
    renderPrivateLink();
    phoneSyncDialog.showModal();
  });
  document.getElementById("privateLinkForm").onsubmit = async event => {
    event.preventDefault();
    const input = document.getElementById("privateLinkInput"); const button = event.currentTarget.querySelector("button");
    try {
      const config = parsePrivateLink(input.value);
      button.disabled = true;
      const loaded = await connectPrivateConfiguration(config);
      input.value = ""; renderPrivateLink();
      showToast(loaded ? "此设备已关联专属题库，以后打开即可同步" : "关联信息已记住，请点击重试同步完成连接");
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  };
  setInterval(pollServer, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void pollServer(); });
  window.addEventListener("focus", () => void pollServer());
  window.addEventListener("online", () => void pollServer());
  window.addEventListener("offline", () => setSyncStatus("offline", "离线，修改保存在本设备"));

  let historySnapshot = null;
  let historyBusy = false;
  document.getElementById("closeHistoryButton").onclick = () => { if (!historyBusy) historyDialog.close(); };
  historyDialog.addEventListener("cancel", event => { if (historyBusy) event.preventDefault(); });
  document.getElementById("historyButton").onclick = async () => {
    if (!cloudConfig) { showToast("请先关联云端题库，再查看历史版本"); return; }
    if (state.loading || historyBusy) return;
    if ((syncDirty || journals().length) && !await writeCardsToDisk()) { showToast("请先完成待同步修改，再打开历史版本"); return; }
    historyDialog.showModal(); historySnapshot = null;
    const status = document.getElementById("historyStatus"); status.textContent = "正在读取历史版本…";
    document.getElementById("historyPreview").hidden = true;
    document.getElementById("restoreHistoryButton").hidden = true;
    const list = document.getElementById("historyList"); list.replaceChildren();
    try {
      const response = await libraryRequest({ path: "/history", cache: "no-store" });
      if (!response.ok) throw new Error("历史版本暂时无法读取，请稍后重试。");
      const data = await response.json(); if (!Array.isArray(data.versions)) throw new Error("历史版本格式不正确。");
      for (const version of data.versions) {
        const button = document.createElement("button"); button.className = "history-version"; button.type = "button";
        button.setAttribute("aria-pressed", "false");
        button.textContent = `${new Date(version.savedAt).toLocaleString("zh-CN", { hour12: false })} · ${version.count} 张 · 收藏 ${version.starred} · 一般 ${version.normal} · 熟练 ${version.mastered}${version.revision === data.currentRevision ? " · 当前版本" : ""}`;
        button.onclick = async () => {
          if (historyBusy) return; historyBusy = true; historySnapshot = null;
          document.getElementById("restoreHistoryButton").hidden = true;
          try {
            const result = await libraryRequest({ path: `/history/${encodeURIComponent(version.revision)}`, cache: "no-store" });
            const snapshot = await result.json(); if (!result.ok || !validServerLibrary(snapshot)) throw new Error(snapshot.error || "无法预览此版本。");
            historySnapshot = snapshot;
            list.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
            const existing = new Map(state.cards.map(c => [c.id, c])); const incoming = new Map(snapshot.cards.map(c => [c.id, c]));
            const additions = snapshot.cards.filter(c => !existing.has(c.id)).length;
            const removals = state.cards.filter(c => !incoming.has(c.id)).length;
            const updates = snapshot.cards.filter(c => existing.has(c.id) && JSON.stringify(normalizeCard(c)) !== JSON.stringify(normalizeCard(existing.get(c.id)))).length;
            const preview = document.getElementById("historyPreview"); preview.hidden = false;
            preview.innerHTML = `<h3>恢复预览</h3><p>相对本设备：新增 ${additions} 张、更新 ${updates} 张、移除 ${removals} 张。恢复包括题目、答案、熟练度与收藏。</p><p>此版本的前 3 张题目：</p><ul>${snapshot.cards.slice(0, 3).map(c => `<li>${escapeHtml(c.question)}</li>`).join("")}</ul>`;
            document.getElementById("restoreHistoryButton").hidden = version.revision === data.currentRevision;
            status.textContent = version.revision === data.currentRevision ? "这是当前版本，无需恢复。" : "恢复后，当前版本仍会保存在历史记录中。";
          } catch (error) { status.textContent = error.message; }
          finally { historyBusy = false; }
        };
        list.append(button);
      }
      status.textContent = data.versions.length ? "选择一个版本预览变化。" : "还没有历史版本。";
    } catch (error) { status.textContent = error.message; }
  };
  document.getElementById("restoreHistoryButton").onclick = async () => {
    if (!historySnapshot || historyBusy) return;
    const status = document.getElementById("historyStatus");
    if (syncDirty || journals().length) { status.textContent = "还有待同步修改，请先关闭历史窗口完成同步。"; return; }
    historyBusy = true;
    try {
      const response = await libraryRequest({ cache: "no-store" }); const latest = await response.json();
      if (!response.ok || !validServerLibrary(latest)) throw new Error("无法读取最新题库，未进行恢复。");
      const incoming = new Set(historySnapshot.cards.map(c => c.id));
      const removed = latest.cards.filter(c => !incoming.has(c.id)).length;
      if (!confirm(`恢复到 ${new Date(historySnapshot.savedAt).toLocaleString("zh-CN")} 的版本，共 ${historySnapshot.cards.length} 张。\n恢复当时的题目、答案、熟练度和收藏；当前有 ${removed} 张卡片不在该版本中，将被移除。当前版本会保留在历史记录中。继续吗？`)) return;
      const result = await libraryRequest({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards: historySnapshot.cards, deletedCardIds: historySnapshot.deletedCardIds, baseRevision: latest.revision }) });
      if (result.status === 409) throw new Error("另一设备刚刚更新了题库，请重新核对后恢复。");
      if (!result.ok) throw new Error("恢复请求未确认完成，请重新读取历史版本核对。");
      const refreshed = await libraryRequest({ cache: "no-store" }); const payload = await refreshed.json();
      if (!refreshed.ok || !validServerLibrary(payload)) throw new Error("保存已提交，请刷新页面确认恢复结果。");
      state.query = ""; state.category = "全部"; state.starredOnly = false; state.proficiency = "全部";
      els.searchInput.value = ""; document.getElementById("proficiencyFilter").value = "全部";
      setServerBase(payload); replaceLibrary(payload.cards, payload.deletedCardIds); syncDirty = false; persistSyncMeta();
      setSyncStatus("saved", "历史版本已恢复"); historyDialog.close(); showToast("历史版本已恢复并同步");
    } catch (error) { status.textContent = error.message; }
    finally { historyBusy = false; }
  };

  document.getElementById("proficiencyFilter").value = state.proficiency;
  els.searchInput.value = state.query;
  document.getElementById("proficiencyFilter").onchange = event => { state.proficiency = event.target.value; state.revealStage = 0; render(); };
  document.getElementById("undoRatingButton").onclick = () => {
    if (state.loading || !undoRatings.length) return;
    const entry = undoRatings[undoRatings.length - 1]; const card = state.cards.find(c => c.id === entry.id);
    if (!card || card.proficiency !== entry.next) {
      undoRatings.pop(); showToast("这张卡片已被其他操作更新，未覆盖它的新标记");
    } else {
      card.proficiency = entry.previous;
      try { saveCards(); } catch { card.proficiency = entry.next; showToast("撤销未保存，请稍后重试"); return; }
      undoRatings.pop(); keepEditedCardVisible(card);
      if (state.proficiency !== "全部" && state.proficiency !== card.proficiency) state.proficiency = "全部";
      document.getElementById("proficiencyFilter").value = state.proficiency;
      state.revealStage = 0; showToast("已撤销上次熟练度标记");
    }
    try { sessionStorage.setItem("interview-rating-undo:v1", JSON.stringify(undoRatings)); } catch {}
    render();
  };
  let installationPrompt = null;
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installationPrompt = event; });
  document.getElementById("installAppButton").onclick = async () => {
    const hint = document.getElementById("installAppHint");
    if (installationPrompt) { await installationPrompt.prompt(); installationPrompt = null; }
    else hint.textContent = /iPad|iPhone|iPod/.test(navigator.userAgent) ? "在 Safari 点“分享”，然后选择“添加到主屏幕”。请先复制你的完整同步链接；如果主屏幕应用要求关联，粘贴一次即可。" : "在浏览器菜单中选择“安装应用”或“添加到主屏幕”。首次联网打开后即可准备离线页面。";
  };
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("review-sw.js").then(registration => {
      const hint = document.getElementById("installAppHint");
      navigator.serviceWorker.ready.then(() => { hint.textContent = "离线页面已准备。已缓存的卡片可离线复习，恢复联网后自动同步。"; });
      registration.addEventListener("updatefound", () => { const worker = registration.installing; worker?.addEventListener("statechange", () => { if (worker.state === "installed" && navigator.serviceWorker.controller) showToast("有新版本可用，下次打开页面时生效"); }); });
    }).catch(() => { document.getElementById("installAppHint").textContent = "离线页面暂未准备完成，请保持联网后重新打开。"; });
  }

  // Phone controls expand on demand without changing card data or storage.
  const ratingMedia = window.matchMedia("(max-width: 900px)");
  const ratingToggle = document.getElementById("ratingToggleButton");
  const ratingActions = document.getElementById("ratingActions");
  const reviewControls = document.querySelector(".review-controls");
  function setRatingExpanded(expanded) {
    const restoreFocus = !expanded && ratingActions.contains(document.activeElement);
    reviewControls.classList.toggle("rating-expanded", expanded);
    ratingToggle.setAttribute("aria-expanded", String(!ratingMedia.matches || expanded));
    if (restoreFocus && ratingMedia.matches) ratingToggle.focus({ preventScroll: true });
  }
  ratingToggle.onclick = () => setRatingExpanded(!reviewControls.classList.contains("rating-expanded"));
  ratingActions.addEventListener("click", () => { if (ratingMedia.matches) setRatingExpanded(false); });
  const updateRatingLayout = () => setRatingExpanded(false);
  if (ratingMedia.addEventListener) ratingMedia.addEventListener("change", updateRatingLayout);
  else ratingMedia.addListener(updateRatingLayout);
  updateRatingLayout();

  const progressPanel = document.querySelector(".progress-panel");
  const progressToggle = document.getElementById("progressToggleButton");
  function setProgressExpanded(expanded) {
    const restoreFocus = !expanded && progressPanel.contains(document.activeElement) && document.activeElement !== progressToggle;
    progressPanel.classList.toggle("progress-expanded", expanded);
    progressToggle.setAttribute("aria-expanded", String(!ratingMedia.matches || expanded));
    if (restoreFocus && ratingMedia.matches) progressToggle.focus({ preventScroll: true });
  }
  progressToggle.onclick = () => setProgressExpanded(!progressPanel.classList.contains("progress-expanded"));
  const updateProgressLayout = () => setProgressExpanded(false);
  if (ratingMedia.addEventListener) ratingMedia.addEventListener("change", updateProgressLayout);
  else ratingMedia.addListener(updateProgressLayout);
  updateProgressLayout();

  const readingToggle = document.getElementById("readingToggleButton");
  const readingClose = document.getElementById("closeReadingButton");
  const studyCard = document.querySelector(".study-card");
  function setReadingExpanded(expanded, restoreFocus = false) {
    if (expanded && (!ratingMedia.matches || !activeCard() || state.revealStage === 0)) return;
    const wasExpanded = document.body.classList.contains("reading-expanded");
    document.body.classList.toggle("reading-expanded", expanded);
    if (expanded) {
      studyCard.setAttribute("role", "dialog");
      studyCard.setAttribute("aria-modal", "true");
      studyCard.setAttribute("aria-label", "答案全文阅读");
      readingClose.focus({ preventScroll: true });
    } else {
      studyCard.removeAttribute("role");
      studyCard.removeAttribute("aria-modal");
      studyCard.removeAttribute("aria-label");
      if (wasExpanded && restoreFocus) (state.revealStage > 0 ? readingToggle : els.flipButton).focus({ preventScroll: true });
    }
  }
  readingToggle.onclick = () => setReadingExpanded(true);
  readingClose.onclick = () => setReadingExpanded(false, true);
  const updateReadingLayout = () => {
    if (!ratingMedia.matches && document.body.classList.contains("reading-expanded")) {
      setReadingExpanded(false);
      els.flashcard.focus({ preventScroll: true });
    }
  };
  if (ratingMedia.addEventListener) ratingMedia.addEventListener("change", updateReadingLayout);
  else ratingMedia.addListener(updateReadingLayout);
  document.addEventListener("keydown", event => {
    if (cardEditorDialog.open) return;
    if (!document.body.classList.contains("reading-expanded")) return;
    if (event.key === "Escape") { event.preventDefault(); setReadingExpanded(false, true); }
    if (event.key === "Tab") {
      const controls = [...studyCard.querySelectorAll("button:not(:disabled), [tabindex='0']")].filter(element => element.getClientRects().length);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  // Sidebar visibility is presentation state only; card storage stays unchanged.
  const sidebarMedia = window.matchMedia("(max-width: 900px)");
  const workspace = document.getElementById("reviewWorkspace");
  const sidebar = document.getElementById("libraryPanel");
  const sidebarToggle = document.getElementById("sidebarToggleButton");
  const sidebarClose = document.getElementById("closeSidebarButton");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  let sidebarCollapsed = sidebarMedia.matches;
  function setSidebarCollapsed(collapsed, focusToggle = false) {
    sidebarCollapsed = collapsed;
    workspace.classList.toggle("sidebar-collapsed", collapsed);
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.setAttribute("aria-label", collapsed ? "展开题库" : "收起题库");
    sidebarToggle.title = collapsed ? "展开题库" : "收起题库";
    sidebar.inert = collapsed;
    const drawerOpen = sidebarMedia.matches && !collapsed;
    document.querySelector(".main-column").inert = drawerOpen;
    sidebarBackdrop.classList.toggle("hidden", !drawerOpen);
    document.body.classList.toggle("sidebar-drawer-open", drawerOpen);
    if (drawerOpen) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      document.getElementById("filterDetails").open = true;
    } else {
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
    }
    if (focusToggle) sidebarToggle.focus({ preventScroll: true });
  }
  sidebarToggle.onclick = () => {
    setSidebarCollapsed(!sidebarCollapsed);
    if (sidebarMedia.matches && !sidebarCollapsed) sidebarClose.focus({ preventScroll: true });
  };
  sidebarClose.onclick = sidebarBackdrop.onclick = () => setSidebarCollapsed(true, true);
  const updateSidebarLayout = () => setSidebarCollapsed(sidebarMedia.matches);
  if (sidebarMedia.addEventListener) sidebarMedia.addEventListener("change", updateSidebarLayout);
  else sidebarMedia.addListener(updateSidebarLayout);
  document.addEventListener("keydown", (event) => {
    if (cardEditorDialog.open || syncConflictDialog.open || phoneSyncDialog.open || historyDialog.open) return;
    if (!sidebarMedia.matches || sidebarCollapsed) return;
    if (event.key === "Escape") { event.preventDefault(); setSidebarCollapsed(true, true); }
    if (event.key === "Tab") {
      const controls = [...sidebar.querySelectorAll("button:not(:disabled), input, summary")].filter((element) => element.getClientRects().length);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  setSidebarCollapsed(sidebarCollapsed);

  document.getElementById("dismissStorageNotice").onclick = () => {
    els.localStorageNotice.classList.add("hidden");
    try { sessionStorage.setItem("java-interview-local-notice-dismissed", "1"); } catch {}
  };
  els.allCardsButton.onclick = () => { state.starredOnly = false; state.category = "全部"; state.revealStage = 0; render(); };
  els.starredFilterButton.onclick = () => { state.starredOnly = true; state.category = "全部"; state.revealStage = 0; render(); };
  els.previousCardButton.onclick = () => moveCard(-1);
  els.nextCardButton.onclick = () => moveCard(1);
  els.starToggleButton.onclick = (event) => { event.stopPropagation(); toggleStar(); };
  els.starToggleButtonBack.onclick = (event) => { event.stopPropagation(); toggleStar(); };
  els.exportProgressButton.onclick = exportProgress;
  document.getElementById("exportLibraryButton").onclick = exportLibrary;
  els.importProgressButton.onclick = () => els.progressFileInput.click();
  els.progressFileInput.onchange = () => importProgress(els.progressFileInput.files[0]);
  const mobileLayout = window.matchMedia("(max-width: 720px)");
  syncResponsiveDisclosures();
  if (mobileLayout.addEventListener) mobileLayout.addEventListener("change", syncResponsiveDisclosures);
  else mobileLayout.addListener(syncResponsiveDisclosures);

  els.searchInput.oninput = () => { state.query = els.searchInput.value.trim(); render(); };
  els.flipButton.onclick = flip;
  els.flashcard.onclick = (event) => { if (state.revealStage === 0 && !event.target.closest("button") && !window.getSelection()?.toString()) flip(); };
  els.flashcard.onkeydown = (event) => { if (event.target === els.flashcard && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); flip(); } };
  els.showDetailedButton.onclick = (event) => { event.stopPropagation(); showDetailedAnswer(); };
  els.weakButton.onclick = () => updateProficiency("生疏"); els.normalButton.onclick = () => updateProficiency("一般"); els.masteredButton.onclick = () => updateProficiency("熟练");
  document.onkeydown = (e) => { if (cardEditorDialog.open || syncConflictDialog.open || phoneSyncDialog.open || historyDialog.open || e.target.matches("input, textarea, select")) return; if (e.key === "f" || e.key === "F") { e.preventDefault(); flip(); } else if (e.key === "1") { e.preventDefault(); updateProficiency("生疏"); } else if (e.key === "2") { e.preventDefault(); updateProficiency("一般"); } else if (e.key === "3") { e.preventDefault(); updateProficiency("熟练"); } else if (e.key === "ArrowLeft") { e.preventDefault(); moveCard(-1); } else if (e.key === "ArrowRight") { e.preventDefault(); moveCard(1); } };

  renderStorageNotice();
  render();
  if (recoveredLegacyCards || refreshedLegacyCards) showToast(`已恢复 ${recoveredLegacyCards || refreshedLegacyCards} 张旧版八股卡片`);
  (async () => {
    if (!cloudConfig) {
      const config = await localPrivateConfiguration();
      if (config) selectCloudConfiguration(config);
    }
    serverAvailable = Boolean(cloudConfig) || localApiOrigin();
    if (!serverAvailable) setSyncStatus("browser", "仅保存在此浏览器");
    if (isLocalCardServer()) await loadCardsFromDisk();
    await loadInitialCards();
    if (serverAvailable && serverStorageLoaded && !serverFileExists && state.cards.length) { syncDirty = true; persistSyncMeta(); }
    if (serverAvailable && serverStorageLoaded && (syncDirty || serverSavePending)) { serverSavePending = false; scheduleServerSave(); }
    state.loading = false;
    render();
    if (!serverAvailable && !state.cards.length && /^https?:$/.test(location.protocol)) { renderPrivateLink(); phoneSyncDialog.showModal(); }
  })();
})();
