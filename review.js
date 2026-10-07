(function () {
  "use strict";

  const STORAGE_KEY = "java-interview-flashcards:simple:v1";
  const INITIAL_CARDS_KEY = "java-interview-flashcards:content-version:v1";
  const LEGACY_KEY = "java-interview-flashcards:v1";
  const PROFICIENCY = ["生疏", "一般", "熟练"];
  const DEFAULT_CATEGORIES = ["Agent", "MySQL", "计算机网络", "Spring Boot", "JVM", "Redis", "操作系统"];
  const els = Object.fromEntries(["searchInput", "categoryFilters", "starredFilterButton", "cardCount", "cardList", "flashcard", "flipButton", "cardCategory", "cardProficiency", "cardQuestion", "cardFlipTip", "cardCategoryBack", "cardProficiencyBack", "cardAnswerLabel", "cardAnswer", "showDetailedButton", "starToggleButton", "starToggleButtonBack", "weakButton", "normalButton", "masteredButton", "totalCount", "weakCount", "normalCount", "masteredCount", "studyTip", "toast", "localStorageNotice", "exportProgressButton", "importProgressButton", "progressFileInput"].map((id) => [id, document.getElementById(id)]));
  let recoveredLegacyCards = 0;
  let refreshedLegacyCards = 0;
  let serverStorageLoaded = false;
  let serverSavePending = false;
  const state = { cards: loadCards(), query: "", category: "全部", starredOnly: false, activeId: null, revealStage: 0, loading: true };
  ["allCardsButton", "previousCardButton", "nextCardButton", "cardQuestionBack", "cardPosition", "collectionTitle", "masteryPercentage", "masteryMeter", "masteryFill"].forEach((id) => { els[id] = document.getElementById(id); });

  function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function saveCards() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards)); scheduleServerSave(); }
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
  function isLocalCardServer() { return location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(location.hostname); }
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
    const merged = primary.map(normalizeCard);
    secondary.map(normalizeCard).forEach((incoming) => {
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
    if (location.protocol === "file:") return;
    try {
      const response = await fetch("initial-cards.json", { cache: "no-store" });
      if (!response.ok) throw new Error("读取初始卡片失败");
      const payload = await response.json();
      const initialCards = Array.isArray(payload.cards) ? payload.cards : [];
      const revision = String(payload.contentVersion || payload.savedAt || "initial");
      if (localStorage.getItem(INITIAL_CARDS_KEY) === revision && state.cards.length && !state.cards.some(hasDamagedText)) return;
      state.cards = mergeCardCollections(state.cards, initialCards);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
      localStorage.setItem(INITIAL_CARDS_KEY, revision);
      render();
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
  function chooseActive() {
    const cards = filteredCards();
    if (!cards.some((card) => card.id === state.activeId)) {
      state.activeId = cards[0]?.id || null;
      state.revealStage = 0;
    }
  }

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
    els.allCardsButton.classList.toggle("active", !state.starredOnly);
    els.allCardsButton.setAttribute("aria-pressed", String(!state.starredOnly));
  }
  function renderCard() {
    const card = activeCard(); const hasCard = Boolean(card);
    if (!hasCard || state.revealStage === 0) setReadingExpanded(false, true);
    const visibleCards = filteredCards();
    const position = visibleCards.findIndex((item) => item.id === card?.id) + 1;
    els.collectionTitle.textContent = state.starredOnly ? `重点集${state.category !== "全部" ? ` / ${state.category}` : ""}` : state.category === "全部" ? "全部卡片" : state.category;
    els.cardPosition.textContent = hasCard ? `第 ${position} / ${visibleCards.length} 张` : "暂无符合条件的卡片";
    els.previousCardButton.disabled = !hasCard;
    els.nextCardButton.disabled = !hasCard;
    const viewKey = `${card?.id || "empty"}:${state.revealStage}`;
    if (els.flashcard.dataset.viewKey !== viewKey) els.flashcard.scrollTop = 0;
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
      els.cardFlipTip.textContent = state.loading ? "稍等片刻，正在整理题目。" : state.starredOnly ? "回到全部卡片，点 ☆ 标记重点；也可以调整分类或搜索。" : "试试其他关键词，或切换到全部分类。";
      els.cardAnswer.textContent = els.cardFlipTip.textContent;
      els.showDetailedButton.classList.add("hidden"); els.showDetailedButton.disabled = true; return;
    }
    els.cardCategory.textContent = card.category; els.cardCategoryBack.textContent = card.category; els.cardProficiency.textContent = card.proficiency; els.cardProficiencyBack.textContent = card.proficiency; els.cardQuestion.textContent = card.question;
    els.cardQuestionBack.textContent = card.question;
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
  document.onkeydown = (e) => { if (e.target.matches("input, textarea")) return; if (e.key === "f" || e.key === "F") { e.preventDefault(); flip(); } else if (e.key === "1") { e.preventDefault(); updateProficiency("生疏"); } else if (e.key === "2") { e.preventDefault(); updateProficiency("一般"); } else if (e.key === "3") { e.preventDefault(); updateProficiency("熟练"); } else if (e.key === "ArrowLeft") { e.preventDefault(); moveCard(-1); } else if (e.key === "ArrowRight") { e.preventDefault(); moveCard(1); } };

  renderStorageNotice();
  render();
  if (recoveredLegacyCards || refreshedLegacyCards) showToast(`已恢复 ${recoveredLegacyCards || refreshedLegacyCards} 张旧版八股卡片`);
  (async () => {
    if (isLocalCardServer()) await loadCardsFromDisk();
    await loadInitialCards();
    if (isLocalCardServer()) scheduleServerSave();
    state.loading = false;
    render();
  })();
})();
