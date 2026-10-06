(function () {
  "use strict";

  const STORAGE_KEY = "java-interview-flashcards:simple:v1";
  const INITIAL_CARDS_KEY = "java-interview-flashcards:initial-cards-loaded:v1";
  const LEGACY_KEY = "java-interview-flashcards:v1";
  const PROFICIENCY = ["生疏", "一般", "熟练"];
  const DEFAULT_CATEGORIES = ["Agent", "MySQL", "计算机网络", "Spring Boot", "JVM", "Redis", "操作系统"];
  const els = Object.fromEntries(["searchInput", "categoryFilters", "starredFilterButton", "cardCount", "cardList", "flashcard", "flipButton", "cardCategory", "cardProficiency", "cardQuestion", "cardFlipTip", "cardCategoryBack", "cardProficiencyBack", "cardAnswerLabel", "cardAnswer", "showDetailedButton", "starToggleButton", "starToggleButtonBack", "weakButton", "normalButton", "masteredButton", "totalCount", "weakCount", "normalCount", "masteredCount", "studyTip", "toast", "localStorageNotice", "exportProgressButton", "importProgressButton", "progressFileInput"].map((id) => [id, document.getElementById(id)]));
  let recoveredLegacyCards = 0;
  let refreshedLegacyCards = 0;
  let serverStorageLoaded = false;
  let serverSavePending = false;
  const state = { cards: loadCards(), query: "", category: "全部", starredOnly: false, activeId: null, revealStage: 0, preferredCategory: DEFAULT_CATEGORIES[0] };

  function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function saveCards() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards)); scheduleServerSave(); }
  function createId() { return `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
  function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function formatText(value) {
    return escapeHtml(value)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replaceAll("\n", "<br>");
  }
  function conciseAnswer(answer) {
    const firstParagraph = String(answer || "").trim().split(/\n\s*\n/)[0].trim();
    if (firstParagraph.length <= 180) return firstParagraph;
    const sentence = firstParagraph.match(/^.{1,180}?[。！？；.!?]/)?.[0];
    return sentence || `${firstParagraph.slice(0, 180)}…`;
  }
  function showToast(message) { els.toast.textContent = message; els.toast.classList.add("visible"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove("visible"), 2400); }
  function proficiencyIndex(value) { return Math.max(0, PROFICIENCY.indexOf(value)); }
  function isLocalCardServer() { return location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(location.hostname); }
  function renderStorageNotice() {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("java-interview-local-notice-dismissed") === "1"; } catch {}
    els.localStorageNotice.classList.toggle("hidden", location.protocol !== "file:" || dismissed);
  }
  function syncResponsiveDisclosures() {
    const isMobile = window.matchMedia("(max-width: 720px)").matches;
    document.getElementById("filterDetails").open = !isMobile;
    document.getElementById("statsDetails").open = !isMobile;
  }
  function cardKey(card) { return `${card.category}\u0000${card.question}`; }
  function mergeCardCollections(primary, secondary) {
    const merged = primary.map(normalizeCard);
    secondary.map(normalizeCard).forEach((incoming) => {
      const index = merged.findIndex((card) => card.id === incoming.id || cardKey(card) === cardKey(incoming));
      if (index < 0) { merged.push(incoming); return; }
      const current = merged[index];
      merged[index] = { ...incoming, ...current, briefAnswer: current.briefAnswer || incoming.briefAnswer, detailedAnswer: current.detailedAnswer.length >= incoming.detailedAnswer.length ? current.detailedAnswer : incoming.detailedAnswer };
    });
    return merged;
  }
  function scheduleServerSave() {
    if (!isLocalCardServer()) return;
    if (!serverStorageLoaded) { serverSavePending = true; return; }
    clearTimeout(scheduleServerSave.timer);
    scheduleServerSave.timer = setTimeout(writeCardsToDisk, 350);
  }
  async function writeCardsToDisk() {
    if (!isLocalCardServer()) return;
    const snapshot = state.cards.map(normalizeCard);
    try {
      const response = await fetch("/api/interview-cards", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards: snapshot }) });
      if (!response.ok) throw new Error("保存失败");
    } catch (error) {
      console.warn("本机卡片文件保存失败：", error);
    }
  }
  async function loadCardsFromDisk() {
    if (!isLocalCardServer()) return;
    try {
      const response = await fetch("/api/interview-cards", { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const payload = await response.json(); const diskCards = Array.isArray(payload.cards) ? payload.cards : [];
      state.cards = mergeCardCollections(state.cards, diskCards);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
      serverStorageLoaded = true;
      await writeCardsToDisk();
      render();
      if (diskCards.length) showToast(`已从本机文件加载 ${diskCards.length} 张八股卡片`);
    } catch (error) {
      serverStorageLoaded = true;
      console.warn("本机卡片文件不可用，将继续使用浏览器本地数据：", error);
    } finally {
      if (serverSavePending) { serverSavePending = false; scheduleServerSave(); }
    }
  }
  async function loadInitialCards() {
    if (isLocalCardServer() || localStorage.getItem(INITIAL_CARDS_KEY)) return;
    try {
      const response = await fetch("initial-cards.json", { cache: "no-store" });
      if (!response.ok) throw new Error("读取初始卡片失败");
      const payload = await response.json();
      const initialCards = Array.isArray(payload.cards) ? payload.cards : [];
      state.cards = mergeCardCollections(state.cards, initialCards);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
      localStorage.setItem(INITIAL_CARDS_KEY, "1");
      render();
      if (initialCards.length) showToast(`已加载 ${initialCards.length} 张初始卡片`);
    } catch (error) {
      console.warn("初始卡片加载失败：", error);
    }
  }

  function loadCards() {
    const saved = readJson(STORAGE_KEY, []);
    const currentCards = Array.isArray(saved) ? saved.map(normalizeCard) : [];
    const legacyPayload = readJson(LEGACY_KEY, []);
    const legacyCards = (Array.isArray(legacyPayload) ? legacyPayload : legacyPayload.cards || []).map(legacyCardToSimple).filter((card) => card.question || card.briefAnswer || card.detailedAnswer);
    const merged = [...currentCards];
    legacyCards.forEach((legacyCard) => {
      const existingIndex = merged.findIndex((card) => card.id === legacyCard.id || (card.category === legacyCard.category && card.question === legacyCard.question));
      if (existingIndex < 0) { merged.push(legacyCard); recoveredLegacyCards++; return; }
      const existing = merged[existingIndex];
      if (legacyCard.briefAnswer !== existing.briefAnswer || legacyCard.detailedAnswer.length > existing.detailedAnswer.length) refreshedLegacyCards++;
      merged[existingIndex] = {
        ...existing,
        briefAnswer: legacyCard.briefAnswer || existing.briefAnswer,
        detailedAnswer: legacyCard.detailedAnswer.length > existing.detailedAnswer.length ? legacyCard.detailedAnswer : existing.detailedAnswer,
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
    return state.cards.filter((card) => (!state.starredOnly || card.starred) && (state.category === "全部" || card.category === state.category) && (!query || [card.category, card.question, card.briefAnswer, card.detailedAnswer, card.proficiency].join(" ").toLowerCase().includes(query))).sort((a, b) => proficiencyIndex(a.proficiency) - proficiencyIndex(b.proficiency));
  }
  function activeCard() { return state.cards.find((card) => card.id === state.activeId); }
  function hasDetailedAnswer(card) { return Boolean(card?.detailedAnswer?.trim()); }
  function chooseActive() { const cards = filteredCards(); if (!cards.some((card) => card.id === state.activeId)) state.activeId = cards[0]?.id || null; }

  function render() { chooseActive(); renderCategories(); renderStarredFilter(); renderCard(); renderList(); renderStats(); }
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
  }
  function renderCard() {
    const card = activeCard(); const hasCard = Boolean(card);
    els.flashcard.classList.toggle("flipped", state.revealStage > 0); els.flashcard.dataset.proficiency = card?.proficiency || "生疏"; els.flashcard.dataset.revealStage = state.revealStage; els.flipButton.disabled = !hasCard;
    [els.starToggleButton, els.starToggleButtonBack].forEach((button) => {
      button.disabled = !hasCard;
      button.classList.toggle("is-starred", Boolean(card?.starred));
      button.setAttribute("aria-pressed", String(Boolean(card?.starred)));
      button.setAttribute("aria-label", card?.starred ? "从重点集中移除" : "加入重点集");
      button.querySelector("span").textContent = card?.starred ? "★" : "☆";
    });
    [els.weakButton, els.normalButton, els.masteredButton].forEach((button) => button.disabled = !hasCard);
    if (!card) { els.cardCategory.textContent = "未分类"; els.cardProficiency.textContent = "生疏"; els.cardCategoryBack.textContent = "未分类"; els.cardProficiencyBack.textContent = "生疏"; els.cardAnswerLabel.textContent = "精简答案"; els.cardFlipTip.textContent = "加载中或没有符合条件的卡片。"; els.cardQuestion.textContent = "等待数据加载…"; els.cardAnswer.textContent = "答案会显示在这里。"; els.showDetailedButton.classList.add("hidden"); els.showDetailedButton.disabled = true; return; }
    els.cardCategory.textContent = card.category; els.cardCategoryBack.textContent = card.category; els.cardProficiency.textContent = card.proficiency; els.cardProficiencyBack.textContent = card.proficiency; els.cardQuestion.textContent = card.question;
    const hasDetailed = hasDetailedAnswer(card);
    els.cardAnswerLabel.textContent = state.revealStage === 2 && hasDetailed ? "详细答案" : "精简答案"; els.cardAnswer.innerHTML = formatText(state.revealStage === 2 && hasDetailed ? card.detailedAnswer : card.briefAnswer);
    els.showDetailedButton.classList.toggle("hidden", !(state.revealStage === 1 && hasDetailed)); els.showDetailedButton.disabled = !hasDetailed;
    els.flipButton.textContent = state.revealStage === 0 ? "查看精简答案" : "查看题面";
    const visibleCards = filteredCards(); const position = visibleCards.findIndex((item) => item.id === card.id) + 1;
    const positionText = `第 ${position} / ${visibleCards.length} 张`;
    els.cardFlipTip.textContent = state.revealStage === 2 ? `${positionText} · 可在卡片内滚动阅读；点击右上角"查看题面"返回。` : state.revealStage === 1 && hasDetailed ? `${positionText} · 精简答案会保持在此页；需要补充时点击下方"查看详细答案"。` : state.revealStage === 1 ? `${positionText} · 精简答案已是最终页；点击右上角"查看题面"返回。` : `${positionText} · 点击卡片查看精简答案。`;
  }
  function renderList() {
    const cards = filteredCards(); els.cardCount.textContent = `${cards.length} 张卡片 · ${state.starredOnly ? "重点集 · " : ""}生疏优先`;
    els.cardList.innerHTML = cards.map((card) => `<button class="simple-list-card ${card.id === state.activeId ? "active" : ""}" data-proficiency="${escapeHtml(card.proficiency)}" data-starred="${card.starred}" data-id="${escapeHtml(card.id)}" type="button"><span>${escapeHtml(card.category)}</span><strong>${escapeHtml(card.question)}</strong><small>${escapeHtml(card.proficiency)}</small></button>`).join("") || `<p class="note">${state.starredOnly ? "重点集还是空的，点卡片右上角☆标记重点。" : "没有符合条件的卡片。"}</p>`;
    els.cardList.querySelectorAll("button").forEach((button) => button.onclick = () => { state.activeId = button.dataset.id; state.revealStage = 0; render(); });
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
    const card = activeCard(); if (!card) return;
    const cards = filteredCards(); const index = cards.findIndex((item) => item.id === card.id); const nextId = cards.length > 1 ? cards[(index + 1) % cards.length].id : card.id;
    card.proficiency = proficiency; state.activeId = nextId; state.revealStage = 0; saveCards(); render(); showToast(`已标记为"${proficiency}"，已进入下一张`);
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
    const card = activeCard(); if (!card) return;
    card.starred = !card.starred; saveCards(); render();
    showToast(card.starred ? "已加入重点集" : "已从重点集移除");
  }
  function exportProgress() {
    const backup = {
      format: "java-interview-flashcards-progress",
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: state.cards.map((card) => ({ id: card.id, category: card.category, question: card.question, proficiency: card.proficiency, starred: Boolean(card.starred) }))
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `八股卡片进度-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("进度备份已导出");
  }
  async function importProgress(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.format !== "java-interview-flashcards-progress" || backup.version !== 1 || !Array.isArray(backup.cards)) {
        throw new Error("备份格式不受支持。");
      }
      let restored = 0;
      let skipped = 0;
      const byId = new Map(state.cards.map((card) => [card.id, card]));
      for (const entry of backup.cards) {
        if (!entry || typeof entry.category !== "string" || typeof entry.question !== "string" || !PROFICIENCY.includes(entry.proficiency) || typeof entry.starred !== "boolean") {
          skipped++;
          continue;
        }
        const key = cardKey({ category: entry.category.trim(), question: entry.question.trim() });
        const card = (typeof entry.id === "string" ? byId.get(entry.id) : null) || state.cards.find((item) => cardKey(item) === key);
        if (!card) { skipped++; continue; }
        card.proficiency = entry.proficiency;
        card.starred = entry.starred;
        restored++;
      }
      if (restored) {
        saveCards();
        render();
      }
      showToast(restored ? `已恢复 ${restored} 张卡片的进度${skipped ? `，跳过 ${skipped} 张` : ""}` : "没有匹配到可恢复的卡片");
    } catch (error) {
      showToast(error.message || "无法读取这个进度备份");
    } finally {
      els.progressFileInput.value = "";
    }
  }

  document.getElementById("dismissStorageNotice").onclick = () => {
    els.localStorageNotice.classList.add("hidden");
    try { sessionStorage.setItem("java-interview-local-notice-dismissed", "1"); } catch {}
  };
  els.starredFilterButton.onclick = () => { state.starredOnly = !state.starredOnly; state.revealStage = 0; render(); };
  els.starToggleButton.onclick = (event) => { event.stopPropagation(); toggleStar(); };
  els.starToggleButtonBack.onclick = (event) => { event.stopPropagation(); toggleStar(); };
  els.exportProgressButton.onclick = exportProgress;
  els.importProgressButton.onclick = () => els.progressFileInput.click();
  els.progressFileInput.onchange = () => importProgress(els.progressFileInput.files[0]);
  const mobileLayout = window.matchMedia("(max-width: 720px)");
  syncResponsiveDisclosures();
  if (mobileLayout.addEventListener) mobileLayout.addEventListener("change", syncResponsiveDisclosures);
  else mobileLayout.addListener(syncResponsiveDisclosures);

  els.searchInput.oninput = () => { state.query = els.searchInput.value.trim(); render(); };
  els.flipButton.onclick = flip; els.flashcard.onclick = flip; els.flashcard.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") flip(); }; els.showDetailedButton.onclick = showDetailedAnswer;
  els.weakButton.onclick = () => updateProficiency("生疏"); els.normalButton.onclick = () => updateProficiency("一般"); els.masteredButton.onclick = () => updateProficiency("熟练");
  document.onkeydown = (e) => { if (e.target.matches("input, textarea")) return; if (e.key === "f" || e.key === "F") { e.preventDefault(); flip(); } else if (e.key === "1") { e.preventDefault(); updateProficiency("生疏"); } else if (e.key === "2") { e.preventDefault(); updateProficiency("一般"); } else if (e.key === "3") { e.preventDefault(); updateProficiency("熟练"); } else if (e.key === "ArrowLeft") { e.preventDefault(); moveCard(-1); } else if (e.key === "ArrowRight") { e.preventDefault(); moveCard(1); } };

  renderStorageNotice();
  render();
  if (recoveredLegacyCards || refreshedLegacyCards) showToast(`已恢复 ${recoveredLegacyCards || refreshedLegacyCards} 张旧版八股卡片`);
  loadCardsFromDisk();
  loadInitialCards();
})();
