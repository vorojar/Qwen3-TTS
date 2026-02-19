// ===== 状态管理 =====
let currentMode = "preset"; // preset, clone, design
let currentLang = "zh";
let selectedVoiceId = null;
let savedVoices = [];

// 录音相关
let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let selectedFile = null;
let recordingStartTime = null;
let timerInterval = null;

// 单句重新生成相关
let sentenceAudios = []; // 每句音频 base64 数组
let sentenceTexts = []; // 每句文本数组
let sentenceInstructs = []; // 每句情感指令（仅 preset 模式有意义）
let sentenceVoiceConfigs = []; // 每句声音配置（null=默认，{type,speaker/voice_id,label}=覆盖）
let sentenceParagraphBreaks = []; // 段落边界标记：true=该句是段落开头
let lastGenerateParams = null; // {mode, speaker, language, instruct, voice_id, clone_prompt_id}
let clonePromptId = null; // clone 模式的 session ID

// 角色分析结果
let sentenceCharacters = []; // 每句角色名（"旁白" / 角色名）
let characterVoiceMap = {}; // 角色名 → voice config（用户选择后填充）

// 分句预览模式（无音频，纯文本编辑）
let isPreviewing = false;

// 撤销栈
let undoStack = []; // [{index, audio, text}]

// 生成进度
let generatingProgress = -1; // 生成中：已完成句数（0-based index of current），非生成：-1

// 单句试听
let sentencePreviewIndex = -1;

// 统计数据（数值，语言无关）
let lastStatsData = null; // {char_count, sentence_count, elapsed, avg_per_char}

function renderStats() {
  // stats 已移到右上角 status-message，由 showSentenceEditorView 渲染
}

// 根据当前 sentenceTexts 重算统计并更新显示
function refreshStatsFromSentences() {
  if (!lastStatsData || !sentenceTexts.length) return;
  const charCount = sentenceTexts.join("").length;
  lastStatsData.char_count = charCount;
  lastStatsData.sentence_count = sentenceTexts.length;
  renderStats();
  // 同步右上角字数
  document.getElementById("char-count").innerHTML =
    `${charCount} <span data-i18n="stats.chars">${t("stats.chars")}</span>`;
}

// 简单HTML转义（不依赖DOM，state.js加载时editor.js的escapeHtml尚未定义）
function escapeHtmlSimple(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h";
  const days = Math.floor(hours / 24);
  return days + "d";
}

// 句间停顿
let pausePaceMultiplier = 1.0;
let decodedPcmCache = []; // 缓存解码后的 PCM，避免重复 atob

// ===== 项目/章节持久化 (IndexedDB) =====
const PROJECT_DB = "vibevoice_projects";
const PROJECT_DB_VERSION = 1;
const PROJECT_STORE = "projects";
const CHAPTER_STORE = "chapters";

// 当前项目/章节 ID
let currentProjectId = null;
let currentChapterId = null;
let allProjects = []; // [{id, name, createdAt, characterVoiceMap, chapterOrder:[]}]
let expandedProjectId = null; // 侧边栏展开的项目 ID
let chapterCache = {}; // chapterId → chapter meta (不含音频，用于侧边栏渲染)

function openProjectDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PROJECT_DB, PROJECT_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CHAPTER_STORE)) {
        db.createObjectStore(CHAPTER_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ===== 项目 CRUD =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function loadAllProjects() {
  try {
    const db = await openProjectDB();
    return new Promise((resolve) => {
      const tx = db.transaction(PROJECT_STORE, "readonly");
      const req = tx.objectStore(PROJECT_STORE).getAll();
      req.onsuccess = () => {
        db.close();
        const projects = req.result || [];
        projects.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
        resolve(projects);
      };
      req.onerror = () => { db.close(); resolve([]); };
    });
  } catch (e) {
    return [];
  }
}

async function saveProjectMeta(project) {
  try {
    const db = await openProjectDB();
    const tx = db.transaction(PROJECT_STORE, "readwrite");
    tx.objectStore(PROJECT_STORE).put(project);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
  } catch (e) {
    console.warn("saveProjectMeta failed:", e);
  }
}

async function deleteProjectFromDB(projectId) {
  try {
    const db = await openProjectDB();
    // 删除项目
    const tx1 = db.transaction(PROJECT_STORE, "readwrite");
    tx1.objectStore(PROJECT_STORE).delete(projectId);
    await new Promise((r) => { tx1.oncomplete = r; });
    // 删除所有章节
    const tx2 = db.transaction(CHAPTER_STORE, "readwrite");
    const store = tx2.objectStore(CHAPTER_STORE);
    const allChapters = await new Promise((r) => {
      const req = store.getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror = () => r([]);
    });
    for (const ch of allChapters) {
      if (ch.projectId === projectId) store.delete(ch.id);
    }
    await new Promise((r) => { tx2.oncomplete = r; });
    db.close();
  } catch (e) {
    console.warn("deleteProjectFromDB failed:", e);
  }
}

// ===== 章节 CRUD =====
async function saveChapterToDB(chapter) {
  try {
    const db = await openProjectDB();
    const tx = db.transaction(CHAPTER_STORE, "readwrite");
    tx.objectStore(CHAPTER_STORE).put(chapter);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
  } catch (e) {
    console.warn("saveChapterToDB failed:", e);
  }
}

async function loadChapterFromDB(chapterId) {
  try {
    const db = await openProjectDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CHAPTER_STORE, "readonly");
      const req = tx.objectStore(CHAPTER_STORE).get(chapterId);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) {
    return null;
  }
}

async function deleteChapterFromDB(chapterId) {
  try {
    const db = await openProjectDB();
    const tx = db.transaction(CHAPTER_STORE, "readwrite");
    tx.objectStore(CHAPTER_STORE).delete(chapterId);
    await new Promise((r) => { tx.oncomplete = r; });
    db.close();
  } catch (e) {
    console.warn("deleteChapterFromDB failed:", e);
  }
}

async function loadChapterMetasForProject(projectId) {
  try {
    const db = await openProjectDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CHAPTER_STORE, "readonly");
      const req = tx.objectStore(CHAPTER_STORE).getAll();
      req.onsuccess = () => {
        db.close();
        const all = req.result || [];
        resolve(all.filter((ch) => ch.projectId === projectId));
      };
      req.onerror = () => { db.close(); resolve([]); };
    });
  } catch (e) {
    return [];
  }
}

// ===== 当前章节 ↔ 全局状态 =====
function buildChapterData() {
  return {
    id: currentChapterId,
    projectId: currentProjectId,
    name: chapterCache[currentChapterId]?.name || t("project.defaultChapter"),
    sentenceAudios,
    sentenceTexts,
    sentenceInstructs,
    sentenceVoiceConfigs,
    sentenceCharacters,
    sentenceParagraphBreaks,
    lastGenerateParams,
    clonePromptId,
    pausePaceMultiplier,
    inputText: sentenceTexts.length > 0
      ? sentenceTexts.join("")
      : document.getElementById("text-input").value,
    statsData: lastStatsData,
    updatedAt: Date.now(),
  };
}

function loadChapterIntoState(chapter) {
  sentenceAudios = chapter.sentenceAudios || [];
  sentenceTexts = chapter.sentenceTexts || [];
  lastGenerateParams = chapter.lastGenerateParams || null;
  sentenceInstructs = chapter.sentenceInstructs || sentenceTexts.map(() => lastGenerateParams?.instruct || "");
  sentenceVoiceConfigs = chapter.sentenceVoiceConfigs || sentenceTexts.map(() => null);
  sentenceCharacters = chapter.sentenceCharacters || [];
  sentenceParagraphBreaks = chapter.sentenceParagraphBreaks || [];
  clonePromptId = chapter.clonePromptId || null;
  pausePaceMultiplier = chapter.pausePaceMultiplier ?? 1.0;
  lastStatsData = chapter.statsData || null;
  decodedPcmCache = [];
  isPreviewing = false;
  undoStack = [];
  selectedSentenceIndex = -1;
  sentencePreviewIndex = -1;
  generatingProgress = -1;

  // 从项目级加载角色映射
  const project = allProjects.find((p) => p.id === currentProjectId);
  if (project && project.characterVoiceMap) {
    characterVoiceMap = { ...project.characterVoiceMap };
    // 如果章节有角色数据，应用项目级映射到句子
    if (sentenceCharacters.length > 0) {
      for (let i = 0; i < sentenceCharacters.length; i++) {
        const charName = sentenceCharacters[i];
        if (characterVoiceMap[charName] && !sentenceVoiceConfigs[i]) {
          sentenceVoiceConfigs[i] = characterVoiceMap[charName];
        }
      }
    }
  } else {
    characterVoiceMap = {};
  }

  // 恢复输入框
  const inputText = chapter.inputText || "";
  document.getElementById("text-input").value = inputText;
  updateCharCount();
}

// ===== 保存/加载/切换 =====

// saveSession 的替代（兼容名称，所有现有调用点不用改）
async function saveSession() {
  if (!currentProjectId || !currentChapterId) return;
  if (!sentenceAudios.length && !sentenceTexts.length) return;
  try {
    const chapter = buildChapterData();
    await saveChapterToDB(chapter);
    // 更新项目的 characterVoiceMap 和 updatedAt
    const project = allProjects.find((p) => p.id === currentProjectId);
    if (project) {
      project.characterVoiceMap = { ...characterVoiceMap };
      project.updatedAt = Date.now();
      await saveProjectMeta(project);
    }
  } catch (e) {
    console.warn("saveSession failed:", e);
  }
}

// clearSession 的替代
async function clearSession() {
  if (!currentChapterId) return;
  try {
    // 清空当前章节的音频数据，但保留章节本身
    const chapter = {
      id: currentChapterId,
      projectId: currentProjectId,
      name: chapterCache[currentChapterId]?.name || t("project.defaultChapter"),
      sentenceAudios: [],
      sentenceTexts: [],
      sentenceInstructs: [],
      sentenceVoiceConfigs: [],
      sentenceCharacters: [],
      sentenceParagraphBreaks: [],
      lastGenerateParams: null,
      clonePromptId: null,
      pausePaceMultiplier: 1.0,
      inputText: "",
      statsData: null,
      updatedAt: Date.now(),
    };
    await saveChapterToDB(chapter);
  } catch (e) {}
}

async function saveCurrentChapter() {
  await saveSession();
}

async function switchChapter(projectId, chapterId) {
  // 保存当前章节
  if (currentChapterId && (sentenceAudios.length > 0 || sentenceTexts.length > 0)) {
    await saveCurrentChapter();
  }

  currentProjectId = projectId;
  currentChapterId = chapterId;
  expandedProjectId = projectId;
  localStorage.setItem("vibevoice_currentProject", projectId);
  localStorage.setItem("vibevoice_currentChapter", chapterId);

  // 加载章节
  const chapter = await loadChapterFromDB(chapterId);
  if (chapter) {
    loadChapterIntoState(chapter);
  } else {
    // 新章节，空状态
    sentenceAudios = [];
    sentenceTexts = [];
    sentenceInstructs = [];
    sentenceVoiceConfigs = [];
    sentenceCharacters = [];
    characterVoiceMap = {};
    sentenceParagraphBreaks = [];
    lastGenerateParams = null;
    clonePromptId = null;
    lastStatsData = null;
    decodedPcmCache = [];
    isPreviewing = false;
    undoStack = [];
    document.getElementById("text-input").value = "";
    updateCharCount();
  }

  // 重建 UI
  if (sentenceAudios.length > 0) {
    try {
      const merged = mergeAllSentenceAudios();
      currentSubtitles = merged.subtitles;
      audioElement.src = URL.createObjectURL(merged.blob);
      loadWaveform();
      document.getElementById("player-section").classList.remove("hidden");
    } catch (e) {
      console.warn("Chapter audio restore failed:", e);
      sentenceAudios = [];
      decodedPcmCache = [];
      currentSubtitles = null;
      document.getElementById("player-section").classList.add("hidden");
    }
    if (lastStatsData) {
      refreshStatsFromSentences();
      renderStats();
    }
    selectedSentenceIndex = -1;
    showSentenceEditorView();
  } else {
    currentSubtitles = null;
    document.getElementById("player-section").classList.add("hidden");
    hideProgressView();
  }

  renderProjectList();
}

// ===== 项目操作（用户交互） =====
async function createProject(nameArg) {
  const name = nameArg || prompt(t("project.newProjectPrompt"), t("project.untitled"));
  if (!name) return;

  const projectId = generateId();
  const chapterId = generateId();

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    characterVoiceMap: {},
    chapterOrder: [chapterId],
  };

  const chapter = {
    id: chapterId,
    projectId,
    name: t("project.defaultChapter"),
    sentenceAudios: [],
    sentenceTexts: [],
    sentenceInstructs: [],
    sentenceVoiceConfigs: [],
    sentenceCharacters: [],
    sentenceParagraphBreaks: [],
    lastGenerateParams: null,
    clonePromptId: null,
    pausePaceMultiplier: 1.0,
    inputText: "",
    statsData: null,
    updatedAt: Date.now(),
  };

  await saveProjectMeta(project);
  await saveChapterToDB(chapter);
  allProjects.unshift(project);
  chapterCache[chapterId] = { id: chapterId, name: chapter.name, projectId };
  await switchChapter(projectId, chapterId);
}

async function deleteProject(projectId) {
  if (!confirm(t("project.deleteProject"))) return;
  await deleteProjectFromDB(projectId);
  allProjects = allProjects.filter((p) => p.id !== projectId);

  // 如果删的是当前项目
  if (currentProjectId === projectId) {
    if (allProjects.length > 0) {
      const next = allProjects[0];
      const chapterId = next.chapterOrder?.[0];
      if (chapterId) {
        await switchChapter(next.id, chapterId);
        return;
      }
    }
    // 没有项目了，清空状态
    currentProjectId = null;
    currentChapterId = null;
    expandedProjectId = null;
    localStorage.removeItem("vibevoice_currentProject");
    localStorage.removeItem("vibevoice_currentChapter");
    sentenceAudios = [];
    sentenceTexts = [];
    sentenceInstructs = [];
    sentenceVoiceConfigs = [];
    sentenceCharacters = [];
    characterVoiceMap = {};
    sentenceParagraphBreaks = [];
    lastGenerateParams = null;
    clonePromptId = null;
    lastStatsData = null;
    decodedPcmCache = [];
    isPreviewing = false;
    undoStack = [];
    document.getElementById("text-input").value = "";
    document.getElementById("player-section").classList.add("hidden");
    hideProgressView();
    updateCharCount();
    renderProjectList();
    return;
  }
  renderProjectList();
}

async function addChapter(projectId) {
  const project = allProjects.find((p) => p.id === projectId);
  if (!project) return;

  const chapterNum = (project.chapterOrder?.length || 0) + 1;
  const defaultName = t("project.defaultChapter").replace(/\d+/, chapterNum);
  const name = prompt(t("project.newChapterPrompt"), defaultName);
  if (!name) return;

  const chapterId = generateId();
  const chapter = {
    id: chapterId,
    projectId,
    name,
    sentenceAudios: [],
    sentenceTexts: [],
    sentenceInstructs: [],
    sentenceVoiceConfigs: [],
    sentenceCharacters: [],
    sentenceParagraphBreaks: [],
    lastGenerateParams: null,
    clonePromptId: null,
    pausePaceMultiplier: 1.0,
    inputText: "",
    statsData: null,
    updatedAt: Date.now(),
  };

  if (!project.chapterOrder) project.chapterOrder = [];
  project.chapterOrder.push(chapterId);
  project.updatedAt = Date.now();

  await saveChapterToDB(chapter);
  await saveProjectMeta(project);
  chapterCache[chapterId] = { id: chapterId, name, projectId };
  await switchChapter(projectId, chapterId);
}

async function deleteChapter(projectId, chapterId) {
  const project = allProjects.find((p) => p.id === projectId);
  if (!project) return;
  if ((project.chapterOrder?.length || 0) <= 1) {
    // 最后一章不允许删除，提示删除项目
    return;
  }
  if (!confirm(t("project.deleteChapter"))) return;

  await deleteChapterFromDB(chapterId);
  project.chapterOrder = (project.chapterOrder || []).filter((id) => id !== chapterId);
  project.updatedAt = Date.now();
  await saveProjectMeta(project);
  delete chapterCache[chapterId];

  // 如果删的是当前章节，切到第一章
  if (currentChapterId === chapterId) {
    const nextId = project.chapterOrder[0];
    if (nextId) await switchChapter(projectId, nextId);
  } else {
    renderProjectList();
  }
}

async function renameProject(projectId) {
  const project = allProjects.find((p) => p.id === projectId);
  if (!project) return;
  const name = prompt(t("project.renamePrompt"), project.name);
  if (!name || name === project.name) return;
  project.name = name;
  project.updatedAt = Date.now();
  await saveProjectMeta(project);
  renderProjectList();
}

async function renameChapter(projectId, chapterId) {
  const cached = chapterCache[chapterId];
  const currentName = cached?.name || "";
  const name = prompt(t("project.renamePrompt"), currentName);
  if (!name || name === currentName) return;

  // 更新缓存
  if (cached) cached.name = name;

  // 更新 DB
  const chapter = await loadChapterFromDB(chapterId);
  if (chapter) {
    chapter.name = name;
    await saveChapterToDB(chapter);
  }
  renderProjectList();
}

// ===== 侧边栏渲染 =====
async function renderProjectList() {
  const container = document.getElementById("project-list");
  if (!container) return;

  if (allProjects.length === 0) {
    container.innerHTML = `<div class="text-center text-charcoal/50 text-sm py-4">${t("project.empty")}</div>`;
    return;
  }

  let html = "";
  for (const project of allProjects) {
    const isExpanded = expandedProjectId === project.id;
    const isCurrent = currentProjectId === project.id;
    const arrow = isExpanded ? "▼" : "▶";

    html += `<div class="project-group${isCurrent ? " current" : ""}" data-project-id="${project.id}">`;
    html += `<div class="project-header" onclick="toggleProjectExpand('${project.id}')">`;
    html += `<span class="project-arrow">${arrow}</span>`;
    html += `<span class="project-name" ondblclick="event.stopPropagation(); renameProject('${project.id}')">${escapeHtmlSimple(project.name)}</span>`;
    html += `<button class="project-del-btn" onclick="event.stopPropagation(); deleteProject('${project.id}')" title="删除">✕</button>`;
    html += `</div>`;

    if (isExpanded) {
      html += `<div class="project-chapters">`;
      const order = project.chapterOrder || [];
      for (const chId of order) {
        const meta = chapterCache[chId];
        const chName = meta?.name || chId;
        const isActive = currentChapterId === chId;
        html += `<div class="chapter-item${isActive ? " active" : ""}" onclick="switchChapter('${project.id}', '${chId}')">`;
        html += `<span class="chapter-name" ondblclick="event.stopPropagation(); renameChapter('${project.id}', '${chId}')">${escapeHtmlSimple(chName)}</span>`;
        if (order.length > 1) {
          html += `<button class="chapter-del-btn" onclick="event.stopPropagation(); deleteChapter('${project.id}', '${chId}')" title="删除">✕</button>`;
        }
        html += `</div>`;
      }
      html += `<div class="chapter-add" onclick="addChapter('${project.id}')">＋ ${t("project.newChapter")}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

function toggleProjectExpand(projectId) {
  if (expandedProjectId === projectId) {
    expandedProjectId = null;
  } else {
    expandedProjectId = projectId;
    // 确保章节缓存已加载
    const project = allProjects.find((p) => p.id === projectId);
    if (project) {
      loadChapterCacheForProject(project).then(() => renderProjectList());
      return;
    }
  }
  renderProjectList();
}

async function loadChapterCacheForProject(project) {
  const chapters = await loadChapterMetasForProject(project.id);
  for (const ch of chapters) {
    chapterCache[ch.id] = { id: ch.id, name: ch.name, projectId: ch.projectId };
  }
}

// ===== 兼容旧 saveToHistory (generation.js 调用) =====
function saveToHistory(text, mode) {
  // 项目系统下不再需要独立历史，生成结果保存在章节中
  // 更新项目时间戳
  const project = allProjects.find((p) => p.id === currentProjectId);
  if (project) {
    project.updatedAt = Date.now();
    saveProjectMeta(project);
    renderProjectList();
  }
}

// ===== 初始化 & 迁移 =====
async function initProjectSystem() {
  allProjects = await loadAllProjects();

  // 迁移旧 session 数据
  const migrated = await migrateOldSession();

  if (allProjects.length === 0 && !migrated) {
    // 首次使用，显示空侧边栏，等用户点"+"创建
    renderProjectList();
    return;
  }

  // 恢复上次的项目和章节
  const lastProjectId = localStorage.getItem("vibevoice_currentProject");
  const lastChapterId = localStorage.getItem("vibevoice_currentChapter");

  let targetProject = null;
  let targetChapterId = null;

  if (lastProjectId) {
    targetProject = allProjects.find((p) => p.id === lastProjectId);
  }
  if (!targetProject && allProjects.length > 0) {
    targetProject = allProjects[0];
  }

  if (targetProject) {
    // 加载该项目的章节缓存
    await loadChapterCacheForProject(targetProject);

    if (lastChapterId && (targetProject.chapterOrder || []).includes(lastChapterId)) {
      targetChapterId = lastChapterId;
    } else {
      targetChapterId = targetProject.chapterOrder?.[0];
    }

    if (targetChapterId) {
      await switchChapter(targetProject.id, targetChapterId);
    }
  }
}

async function migrateOldSession() {
  // 检查旧 IndexedDB 是否存在数据
  try {
    const oldDB = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vibevoice_session", 1);
      req.onupgradeneeded = () => {
        // 没有旧数据库，关闭并删除
        req.result.close();
        indexedDB.deleteDatabase("vibevoice_session");
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!oldDB) return false;

    const session = await new Promise((resolve) => {
      try {
        const tx = oldDB.transaction("session", "readonly");
        const req = tx.objectStore("session").get("current");
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    oldDB.close();

    if (!session || !session.sentenceAudios || !session.sentenceAudios.length) {
      // 无数据，清理旧库
      indexedDB.deleteDatabase("vibevoice_session");
      return false;
    }

    // 创建迁移项目
    const projectId = generateId();
    const chapterId = generateId();

    const project = {
      id: projectId,
      name: t("project.untitled"),
      createdAt: session.timestamp || Date.now(),
      updatedAt: Date.now(),
      characterVoiceMap: session.characterVoiceMap || {},
      chapterOrder: [chapterId],
    };

    const chapter = {
      id: chapterId,
      projectId,
      name: t("project.defaultChapter"),
      sentenceAudios: session.sentenceAudios,
      sentenceTexts: session.sentenceTexts || [],
      sentenceInstructs: session.sentenceInstructs || [],
      sentenceVoiceConfigs: session.sentenceVoiceConfigs || [],
      sentenceCharacters: session.sentenceCharacters || [],
      sentenceParagraphBreaks: session.sentenceParagraphBreaks || [],
      lastGenerateParams: session.lastGenerateParams || null,
      clonePromptId: session.clonePromptId || null,
      pausePaceMultiplier: session.pausePaceMultiplier ?? 1.0,
      inputText: session.inputText || "",
      statsData: session.statsData || null,
      updatedAt: Date.now(),
    };

    await saveProjectMeta(project);
    await saveChapterToDB(chapter);
    allProjects.unshift(project);
    chapterCache[chapterId] = { id: chapterId, name: chapter.name, projectId };

    // 删除旧库
    indexedDB.deleteDatabase("vibevoice_session");
    // 清除旧 history
    localStorage.removeItem("vibevoice_history");

    return true;
  } catch (e) {
    console.warn("Migration failed:", e);
    return false;
  }
}

// 旧 restoreSession 的兼容函数（不再需要，initProjectSystem 替代）
async function restoreSession() {
  // 空操作，由 initProjectSystem 处理
}
