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
let lastGenerateParams = null; // {mode, speaker, language, instruct, voice_id, clone_prompt_id}
let clonePromptId = null; // clone 模式的 session ID

// 撤销栈
let undoStack = []; // [{index, audio, text}]

// 单句试听
let sentencePreviewIndex = -1;

// 统计数据（数值，语言无关）
let lastStatsData = null; // {char_count, sentence_count, elapsed, avg_per_char}

function renderStats() {
  if (!lastStatsData) return;
  const s = lastStatsData;
  if (s.sentence_count != null) {
    document.getElementById("stats-chars").textContent =
      `${s.char_count} ${t("stats.chars")} · ${s.sentence_count} ${t("stats.sentences")} · ${s.elapsed}s`;
  } else {
    document.getElementById("stats-chars").textContent =
      `${s.char_count} ${t("stats.chars")} · ${s.elapsed}s`;
  }
  document.getElementById("stats-speed").textContent =
    `${s.avg_per_char}s/${t("stats.chars")}`;
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

// 句间停顿
let pausePaceMultiplier = 1.0;
let decodedPcmCache = []; // 缓存解码后的 PCM，避免重复 atob

// ===== 会话持久化 (IndexedDB) =====
const SESSION_DB = "vibevoice_session";
const SESSION_STORE = "session";
const SESSION_KEY = "current";

function openSessionDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SESSION_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSession() {
  if (!sentenceAudios.length) return;
  try {
    const db = await openSessionDB();
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).put(
      {
        sentenceAudios,
        sentenceTexts,
        sentenceInstructs,
        lastGenerateParams,
        clonePromptId,
        currentSubtitles,
        pausePaceMultiplier,
        inputText:
          sentenceTexts.length > 0
            ? sentenceTexts.join("")
            : document.getElementById("text-input").value,
        statsData: lastStatsData,
        timestamp: Date.now(),
      },
      SESSION_KEY,
    );
    db.close();
  } catch (e) {
    console.warn("saveSession failed:", e);
  }
}

async function loadSession() {
  try {
    const db = await openSessionDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readonly");
      const req = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch (e) {
    return null;
  }
}

async function clearSession() {
  try {
    const db = await openSessionDB();
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
    db.close();
  } catch (e) {}
}

async function restoreSession() {
  const session = await loadSession();
  if (!session || !session.sentenceAudios || !session.sentenceAudios.length)
    return;
  // 恢复状态
  sentenceAudios = session.sentenceAudios;
  sentenceTexts = session.sentenceTexts;
  lastGenerateParams = session.lastGenerateParams;
  sentenceInstructs =
    session.sentenceInstructs ||
    sentenceTexts.map(() => lastGenerateParams?.instruct || "");
  clonePromptId = session.clonePromptId;
  currentSubtitles = session.currentSubtitles;
  pausePaceMultiplier = session.pausePaceMultiplier ?? 1.0;
  decodedPcmCache = [];
  // 恢复输入框
  if (session.inputText) {
    document.getElementById("text-input").value = session.inputText;
    updateCharCount();
  }
  // 重建音频
  const merged = mergeAllSentenceAudios();
  currentSubtitles = merged.subtitles;
  audioElement.src = URL.createObjectURL(merged.blob);
  loadWaveform();
  // 恢复 stats 显示
  if (session.statsData) {
    lastStatsData = session.statsData;
  }
  refreshStatsFromSentences();
  // 显示播放器和句子视图
  document.getElementById("player-section").classList.remove("hidden");
  if (sentenceTexts.length > 1) {
    selectedSentenceIndex = -1;
    showSentenceEditorView();
  }
}
