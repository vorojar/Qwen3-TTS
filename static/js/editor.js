// ===== 模式切换 =====
function switchMode(mode) {
  currentMode = mode;

  // 更新导航状态
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.mode === mode);
  });

  // 显示/隐藏配置面板
  document
    .getElementById("config-preset")
    .classList.toggle("hidden", mode !== "preset");
  document
    .getElementById("config-clone")
    .classList.toggle("hidden", mode !== "clone");
  document
    .getElementById("config-design")
    .classList.toggle("hidden", mode !== "design");

  // 显示/隐藏声音库
  document
    .getElementById("voice-library-section")
    .classList.toggle("hidden", mode !== "clone");

  // 切换到 clone 模式时刷新声音库列表（更新选中状态）
  if (mode === "clone") {
    renderVoiceList();
  } else {
    // 离开 clone 模式时清除选中
    selectedVoiceId = null;
  }

  // 隐藏保存区域（播放器保持不变）
  document.getElementById("save-voice-section").classList.add("hidden");
}

// ===== 页面切换 =====
function showPage(page) {
  document
    .getElementById("api-overlay")
    .classList.toggle("hidden", page !== "api");
}

// ===== 字数统计 =====
let langDetectTimer = null;
function updateCharCount() {
  const text = document.getElementById("text-input").value;
  document.getElementById("char-count").innerHTML =
    `${text.length} <span data-i18n="stats.chars">${t("stats.chars")}</span>`;

  // 文本为空时禁用生成按钮
  const btn = document.getElementById("generate-btn");
  if (!isGenerating) {
    btn.disabled = text.trim().length === 0;
  }

  // 自动检测语言（防抖500ms）
  clearTimeout(langDetectTimer);
  langDetectTimer = setTimeout(() => detectAndSetLanguage(text), 500);
}

function detectAndSetLanguage(text) {
  if (!text.trim()) return;
  const counts = { zh: 0, ja: 0, ko: 0, en: 0 };
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) counts.zh++;
    else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x31f0 && code <= 0x31ff)
    )
      counts.ja++;
    else if (code >= 0xac00 && code <= 0xd7af) counts.ko++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      counts.en++;
  }
  const total = counts.zh + counts.ja + counts.ko + counts.en;
  if (total < 5) return;
  let lang = null;
  if (counts.ja > 0 && counts.ja >= counts.zh * 0.1) lang = "Japanese";
  else if (counts.ko > total * 0.3) lang = "Korean";
  else if (counts.zh > total * 0.3) lang = "Chinese";
  else if (counts.en > total * 0.5) lang = "English";
  if (lang) {
    ["language-preset", "language-clone", "language-design"].forEach((id) => {
      document.getElementById(id).value = lang;
    });
  }
}

// 前端分句（与后端保持一致）
function splitTextToSentences(text, minLength = 10) {
  const pattern = /([。！？；.!?;]+|\n)/;
  const parts = text.split(pattern);

  const rawSentences = [];
  let current = "";
  for (const part of parts) {
    current += part;
    if (pattern.test(part)) {
      if (current.trim()) {
        rawSentences.push(current.trim());
      }
      current = "";
    }
  }
  if (current.trim()) {
    rawSentences.push(current.trim());
  }

  if (rawSentences.length === 0) {
    return text.trim() ? [text] : [];
  }

  // 合并过短的句子
  const merged = [];
  let buffer = "";
  for (const sentence of rawSentences) {
    buffer += sentence;
    if (buffer.length >= minLength) {
      merged.push(buffer);
      buffer = "";
    }
  }
  if (buffer) {
    if (merged.length > 0) {
      merged[merged.length - 1] += buffer;
    } else {
      merged.push(buffer);
    }
  }
  return merged;
}

// 显示进度视图
function showProgressView(sentences) {
  const textInput = document.getElementById("text-input");
  const progressView = document.getElementById("progress-view");

  // 构建带样式的句子列表
  let html = "";
  sentences.forEach((sentence, index) => {
    html += `<span id="sentence-${index}" class="sentence-pending">${escapeHtml(sentence)}</span>`;
  });

  progressView.innerHTML = html;
  textInput.classList.add("hidden");
  progressView.classList.remove("hidden");
}

// 更新句子进度样式
function updateSentenceProgress(current) {
  // current 是已完成的数量（1-based）
  for (let i = 0; i < current; i++) {
    const el = document.getElementById(`sentence-${i}`);
    if (el) {
      el.className = "sentence-done";
    }
  }
  // 标记正在生成的句子
  const currentEl = document.getElementById(`sentence-${current}`);
  if (currentEl) {
    currentEl.className = "sentence-current";
  }
}

// 隐藏进度视图
function hideProgressView() {
  const textInput = document.getElementById("text-input");
  const progressView = document.getElementById("progress-view");
  textInput.classList.remove("hidden");
  progressView.style.display = "";
  progressView.style.flexDirection = "";
  progressView.style.overflow = "";
  progressView.classList.add("hidden");
  // 如果有句子数据，显示"返回句子视图"按钮
  const hint = document.getElementById("sentence-view-hint");
  if (hint) {
    hint.classList.toggle("hidden", sentenceAudios.length <= 1);
  }
  updateCharCount();
  // 恢复生成按钮，隐藏句子工具栏
  document.getElementById("generate-btn").style.display = "";
  const toolbar = document.getElementById("sentence-toolbar");
  toolbar.style.display = "none";
  toolbar.classList.add("hidden");
}

// 显示句子编辑视图
let selectedSentenceIndex = -1;

function showSentenceEditorView() {
  const textInput = document.getElementById("text-input");
  const progressView = document.getElementById("progress-view");

  // 找出最近一次撤销对应的句子索引
  const lastUndoIndex =
    undoStack.length > 0 ? undoStack[undoStack.length - 1].index : -1;

  let html =
    '<div style="flex:1;min-height:0;overflow-y:auto" class="scrollbar-thin"><ul class="sentence-editor-list">';
  // 第一句前面的插入按钮
  html += `<li class="sentence-insert-row"><button class="sentence-insert-btn" onclick="event.stopPropagation(); showInsertForm(0)" title="${t("btn.addSentence")}">＋</button></li>`;
  sentenceTexts.forEach((text, index) => {
    const isSelected = index === selectedSentenceIndex;
    const isPreviewPlaying = sentencePreviewIndex === index;
    const hasUndo = index === lastUndoIndex;
    const instruct = sentenceInstructs[index] || "";
    const isPreset = lastGenerateParams && lastGenerateParams.mode === "preset";
    const instructTag = isPreset
      ? `<div class="sentence-instruct-tag" id="sent-instruct-${index}" onclick="event.stopPropagation(); editSentenceInstruct(${index})"><span class="sentence-instruct-label">${t("label.instructLabel")}:</span> <span class="sentence-instruct-value">${instruct ? escapeHtml(instruct) : t("label.instructEmpty")}</span> <span class="sentence-instruct-edit">✏</span></div>`
      : "";
    html += `<li class="sentence-editor-item ${isSelected ? "selected" : ""}"
            id="sent-item-${index}"
            onclick="selectSentenceItem(${index}, event)"
            ondblclick="editSentenceItem(${index})">
            <span class="sentence-editor-index">${index + 1}</span>
            <div style="flex:1;min-width:0">
                <span class="sentence-editor-text" id="sent-text-${index}">${escapeHtml(text)}</span>
                ${instructTag}
            </div>
            <span class="sentence-editor-actions">
                ${hasUndo ? '<button class="sentence-regen-btn" onclick="event.stopPropagation(); undoRegenerate()" title="' + t("btn.undo") + '" style="border-color:#f6ad55;color:#dd6b20">↩</button>' : ""}
                <button class="sentence-play-btn ${isPreviewPlaying ? "playing-now" : ""}" onclick="event.stopPropagation(); previewSentenceAudio(${index})" title="试听">${isPreviewPlaying ? "⏸" : "▶"}</button>
                <button class="sentence-regen-btn" onclick="event.stopPropagation(); regenerateSentence(${index})">${t("btn.regenerate")}</button>
                <button class="sentence-del-btn" onclick="event.stopPropagation(); deleteSentence(${index})" title="删除">✕</button>
            </span>
        </li>`;
    // 插入按钮（每句之后）
    html += `<li class="sentence-insert-row"><button class="sentence-insert-btn" onclick="event.stopPropagation(); showInsertForm(${index + 1})" title="${t("btn.addSentence")}">＋</button></li>`;
  });
  html += "</ul></div>";

  progressView.innerHTML = html;
  textInput.classList.add("hidden");
  progressView.style.display = "flex";
  progressView.style.flexDirection = "column";
  progressView.style.overflow = "hidden";
  progressView.classList.remove("hidden");
  // 隐藏"返回句子视图"提示
  const hint = document.getElementById("sentence-view-hint");
  if (hint) hint.classList.add("hidden");
  // 隐藏生成按钮，显示句子工具栏
  document.getElementById("generate-btn").style.display = "none";
  const toolbar = document.getElementById("sentence-toolbar");
  toolbar.classList.remove("hidden");
  toolbar.style.display = "flex";
  // 同步停顿控件值
  document.getElementById("st-pace-label").textContent = t("label.pace");
  document.getElementById("st-pace-value").textContent =
    pausePaceMultiplier === 0
      ? t("label.paceOff")
      : pausePaceMultiplier.toFixed(1) + "x";
  document.getElementById("st-pace-range").value = pausePaceMultiplier;
}

function exitSentenceEditorView() {
  finishEditing();
  selectedSentenceIndex = -1;
  // 同步句子文本回 textarea
  if (sentenceTexts.length > 0) {
    document.getElementById("text-input").value = sentenceTexts.join("");
  }
  hideProgressView();
}

function selectSentenceItem(index, event) {
  // 如果点击发生在正在编辑的 contenteditable 内，不处理（让光标自由移动）
  if (event && event.target.closest('[contenteditable="true"]')) return;

  // 如果有正在编辑的句子，先保存
  finishEditing();

  selectedSentenceIndex = selectedSentenceIndex === index ? -1 : index;
  // 更新选中状态
  document.querySelectorAll(".sentence-editor-item").forEach((el, i) => {
    el.classList.toggle("selected", i === selectedSentenceIndex);
  });
}

function editSentenceItem(index) {
  // 如果已经在编辑这句了，不重复处理
  const textEl = document.getElementById(`sent-text-${index}`);
  if (textEl && textEl.contentEditable === "true") return;

  finishEditing();
  selectedSentenceIndex = index;
  document.querySelectorAll(".sentence-editor-item").forEach((el, i) => {
    el.classList.toggle("selected", i === index);
  });
  if (textEl) {
    textEl.contentEditable = "true";
    textEl.focus();
    // 光标放到末尾
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Enter 键完成编辑
    textEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finishEditing();
      }
    };
  }
}

function finishEditing() {
  let changed = false;
  document
    .querySelectorAll('.sentence-editor-text[contenteditable="true"]')
    .forEach((el) => {
      el.contentEditable = "false";
      el.onkeydown = null;
      // 获取索引并更新 sentenceTexts
      const idMatch = el.id.match(/sent-text-(\d+)/);
      if (idMatch) {
        const idx = parseInt(idMatch[1]);
        const newText = el.textContent.trim();
        if (newText && newText !== sentenceTexts[idx]) {
          sentenceTexts[idx] = newText;
          changed = true;
        }
      }
    });
  if (changed) {
    refreshStatsFromSentences();
    saveSession(); // 文本编辑后持久化
  }
}

// ===== 逐句情感编辑 =====
function editSentenceInstruct(index) {
  const tag = document.getElementById(`sent-instruct-${index}`);
  if (!tag) return;
  if (tag.querySelector("input")) return; // 已在编辑中
  const currentVal = sentenceInstructs[index] || "";
  tag.innerHTML = `<input type="text" class="sentence-instruct-input"
        value="${escapeHtml(currentVal)}"
        placeholder="${t("label.instructEmpty")}"
        onblur="finishInstructEdit(${index}, this)"
        onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}if(event.key==='Escape'){this.blur();}">`;
  const input = tag.querySelector("input");
  input.focus();
  input.select();
}

function finishInstructEdit(index, inputEl) {
  const newVal = inputEl.value.trim();
  sentenceInstructs[index] = newVal;
  saveSession();
  showSentenceEditorView();
}

// ===== 单句试听 =====
let _sentencePreviewEndHandler = null;

function previewSentenceAudio(index) {
  // 清除之前的句尾监听
  if (_sentencePreviewEndHandler) {
    audioElement.removeEventListener("timeupdate", _sentencePreviewEndHandler);
    _sentencePreviewEndHandler = null;
  }
  // 如果正在播放同一句，停止
  if (sentencePreviewIndex === index && !audioElement.paused) {
    audioElement.pause();
    sentencePreviewIndex = -1;
    showSentenceEditorView();
    return;
  }

  const sub = currentSubtitles && currentSubtitles[index];
  if (!sub) return;

  // 暂停当前播放
  if (!audioElement.paused) audioElement.pause();

  sentencePreviewIndex = index;
  showSentenceEditorView();

  // seek 到句子起点并播放
  audioElement.currentTime = sub.start;
  audioElement.play();

  // 监听 timeupdate，到句尾自动停止
  const endTime = sub.end;
  _sentencePreviewEndHandler = () => {
    if (audioElement.currentTime >= endTime) {
      audioElement.pause();
      audioElement.removeEventListener(
        "timeupdate",
        _sentencePreviewEndHandler,
      );
      _sentencePreviewEndHandler = null;
      sentencePreviewIndex = -1;
      showSentenceEditorView();
    }
  };
  audioElement.addEventListener("timeupdate", _sentencePreviewEndHandler);
}

// ===== 撤销重新生成 =====
function undoRegenerate() {
  if (undoStack.length === 0) return;
  const last = undoStack.pop();
  sentenceAudios[last.index] = last.audio;
  sentenceTexts[last.index] = last.text;
  if (last.instruct !== undefined)
    sentenceInstructs[last.index] = last.instruct;
  // 重新合并
  rebuildAudioAndSubtitles();
  saveSession(); // 持久化
  selectedSentenceIndex = last.index;
  showSentenceEditorView();
  const statusEl = document.getElementById("status-message");
  statusEl.innerHTML = `<span class="text-yellow-600">${t("btn.undo")}</span>`;
}

// ===== 删除句子 =====
function deleteSentence(index) {
  if (sentenceTexts.length <= 1) return; // 至少保留一句
  if (!confirm(t("confirm.deleteSentence"))) return;
  finishEditing();
  sentenceAudios.splice(index, 1);
  sentenceTexts.splice(index, 1);
  sentenceInstructs.splice(index, 1);
  decodedPcmCache = [];
  rebuildAudioAndSubtitles();
  saveSession(); // 持久化
  if (selectedSentenceIndex >= sentenceTexts.length)
    selectedSentenceIndex = sentenceTexts.length - 1;
  if (selectedSentenceIndex === index) selectedSentenceIndex = -1;
  refreshStatsFromSentences();
  showSentenceEditorView();
}

// ===== 插入句子 =====
function showInsertForm(afterIndex) {
  if (!lastGenerateParams) return;
  finishEditing();
  // 取消已有的插入表单
  const existing = document.querySelector(".insert-form-row");
  if (existing) existing.remove();

  const editorList = document.querySelector(".sentence-editor-list");
  if (!editorList) return;

  const isPreset = lastGenerateParams.mode === "preset";
  const defaultInstruct = lastGenerateParams.instruct || "";
  const instructRow = isPreset
    ? `<div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;color:#A0AEC0;white-space:nowrap">${t("label.instructLabel")}:</span>
        <input type="text" id="insert-instruct-input" value="${escapeHtml(defaultInstruct)}" placeholder="${t("label.instructEmpty")}" style="flex:1">
    </div>`
    : "";

  const formHtml = `<li class="insert-form-row"><div class="sentence-insert-form">
        <input type="text" id="insert-text-input" placeholder="${t("btn.insertHint")}" autofocus>
        ${instructRow}
        <div class="sentence-insert-form-actions">
            <button onclick="cancelInsertForm()">${t("btn.stop")}</button>
            <button class="confirm-btn" onclick="confirmInsert(${afterIndex})">${t("btn.addSentence")}</button>
        </div>
    </div></li>`;

  // 找到 afterIndex 对应的插入按钮行
  const items = editorList.children;
  const insertBtnIndex = afterIndex * 2;
  if (insertBtnIndex >= 0 && insertBtnIndex < items.length) {
    items[insertBtnIndex].insertAdjacentHTML("afterend", formHtml);
  } else {
    editorList.insertAdjacentHTML("afterbegin", formHtml);
  }

  const textInput = document.getElementById("insert-text-input");
  textInput.focus();
  // Enter 确认，Escape 取消
  const handleKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmInsert(afterIndex);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelInsertForm();
    }
  };
  textInput.addEventListener("keydown", handleKey);
  const instructInput = document.getElementById("insert-instruct-input");
  if (instructInput) instructInput.addEventListener("keydown", handleKey);
}

function cancelInsertForm() {
  const row = document.querySelector(".insert-form-row");
  if (row) row.remove();
}

async function confirmInsert(afterIndex) {
  const textInput = document.getElementById("insert-text-input");
  const instructInput = document.getElementById("insert-instruct-input");
  const newText = textInput ? textInput.value.trim() : "";
  const newInstruct = instructInput
    ? instructInput.value.trim()
    : lastGenerateParams.instruct || "";
  if (!newText) {
    textInput && textInput.focus();
    return;
  }

  // 移除表单，显示占位行
  cancelInsertForm();

  const statusEl = document.getElementById("status-message");
  const btn = document.getElementById("generate-btn");
  const editorList = document.querySelector(".sentence-editor-list");

  if (editorList) {
    editorList.classList.add("inserting");
    const placeholderHtml = `<li class="inserting-row"><div class="sentence-inserting-placeholder">
            <span class="spinner" style="width:14px;height:14px;border-width:2px"></span>
            <span>${escapeHtml(newText.length > 30 ? newText.slice(0, 30) + "..." : newText)}</span>
        </div></li>`;
    const items = editorList.children;
    const insertBtnIndex = afterIndex * 2;
    if (insertBtnIndex >= 0 && insertBtnIndex < items.length) {
      items[insertBtnIndex].insertAdjacentHTML("afterend", placeholderHtml);
    } else {
      editorList.insertAdjacentHTML("afterbegin", placeholderHtml);
    }
  }

  const originalBtnHtml = btn.innerHTML;
  const originalBtnOnclick = btn.onclick;
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append("sentence_text", newText);
    formData.append("mode", lastGenerateParams.mode);
    formData.append("language", lastGenerateParams.language);
    if (lastGenerateParams.speaker)
      formData.append("speaker", lastGenerateParams.speaker);
    // 使用新句子指定的 instruct
    const instruct =
      lastGenerateParams.mode === "preset" && newInstruct
        ? newInstruct
        : lastGenerateParams.instruct;
    if (instruct) formData.append("instruct", instruct);
    if (lastGenerateParams.voice_id)
      formData.append("voice_id", lastGenerateParams.voice_id);
    if (lastGenerateParams.clone_prompt_id)
      formData.append("clone_prompt_id", lastGenerateParams.clone_prompt_id);

    const response = await fetch("/regenerate", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Generate failed");
    }
    const data = await response.json();

    sentenceAudios.splice(afterIndex, 0, data.audio);
    sentenceTexts.splice(afterIndex, 0, newText);
    sentenceInstructs.splice(afterIndex, 0, newInstruct);
    decodedPcmCache = [];
    rebuildAudioAndSubtitles();
    saveSession();
    selectedSentenceIndex = afterIndex;
    refreshStatsFromSentences();
    showSentenceEditorView();

    const subtitle = currentSubtitles[afterIndex];
    if (subtitle) {
      audioElement.addEventListener("loadedmetadata", function jumpToNew() {
        audioElement.currentTime = subtitle.start;
        audioElement.play();
        audioElement.removeEventListener("loadedmetadata", jumpToNew);
      });
    }
  } catch (error) {
    statusEl.innerHTML = `<span class="text-red-600">${t("status.failed")}: ${error.message}</span>`;
    if (editorList) {
      const placeholder = editorList.querySelector(".inserting-row");
      if (placeholder) placeholder.remove();
      editorList.classList.remove("inserting");
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
    btn.onclick = originalBtnOnclick;
  }
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
