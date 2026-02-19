// ===== 声音库 =====
async function loadSavedVoices() {
  try {
    const response = await fetch("/voices");
    const data = await response.json();
    savedVoices = data.voices || [];
    renderVoiceList();
  } catch (error) {
    console.error("Failed to load voices:", error);
  }
}

// 声音库预览播放器
let previewAudio = null;
let previewingVoiceId = null;

function renderVoiceList() {
  const container = document.getElementById("voice-list");
  if (savedVoices.length === 0) {
    container.innerHTML = `<div class="text-center text-charcoal/50 text-sm py-4">暂无保存的声音</div>`;
    return;
  }

  container.innerHTML = savedVoices
    .map(
      (voice) => `
        <div class="voice-card ${selectedVoiceId === voice.id ? "selected" : ""}" onclick="selectVoice('${voice.id}')">
            <div class="flex items-center justify-between">
                <span class="text-sm font-medium truncate">${voice.name}</span>
                <div class="flex gap-1">
                    <button id="preview-btn-${voice.id}" onclick="event.stopPropagation(); previewVoice('${voice.id}')" class="p-1 hover:bg-warm-gray rounded" title="预览">${previewingVoiceId === voice.id ? "⏸" : "▶"}</button>
                    <button onclick="event.stopPropagation(); deleteVoice('${voice.id}')" class="p-1 hover:bg-red-500/20 hover:text-red-600 rounded" title="删除">✕</button>
                </div>
            </div>
            <div class="text-xs text-charcoal/50 mt-1">${voice.language}</div>
        </div>
    `,
    )
    .join("");
}

function selectVoice(voiceId) {
  selectedVoiceId = selectedVoiceId === voiceId ? null : voiceId;
  renderVoiceList();
  // 刷新句子编辑器中的声音标签
  if (isPreviewing || sentenceAudios.length > 0) {
    showSentenceEditorView();
  }
}

function previewVoice(voiceId) {
  // 如果正在播放同一个声音，则停止
  if (previewingVoiceId === voiceId && previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewAudio = null;
    previewingVoiceId = null;
    renderVoiceList();
    return;
  }

  // 如果正在播放其他声音，先停止
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
  }

  // 播放新声音
  previewAudio = new Audio(`/voices/${voiceId}/preview`);
  previewingVoiceId = voiceId;
  renderVoiceList();

  previewAudio.play();

  // 播放结束后重置状态
  previewAudio.onended = () => {
    previewingVoiceId = null;
    previewAudio = null;
    renderVoiceList();
  };
}

async function deleteVoice(voiceId) {
  if (!confirm(t("confirm.delete"))) return;
  try {
    await fetch(`/voices/${voiceId}`, { method: "DELETE" });
    if (selectedVoiceId === voiceId) selectedVoiceId = null;
    await loadSavedVoices();
  } catch (error) {
    alert("删除失败: " + error.message);
  }
}

async function saveVoice() {
  const name = document.getElementById("voice-name").value.trim();
  if (!name) return;

  const language = document.getElementById("language-clone").value;
  const refText = document.getElementById("ref-text").value.trim();

  let audioFile = recordedBlob
    ? new File([recordedBlob], "recording.webm", { type: "audio/webm" })
    : selectedFile;
  if (!audioFile) return;

  const formData = new FormData();
  formData.append("name", name);
  formData.append("language", language);
  formData.append("ref_text", refText);
  formData.append("audio", audioFile);

  const statusEl = document.getElementById("status-message");
  statusEl.textContent = t("status.saving");

  try {
    const response = await fetch("/voices/save", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) throw new Error("Save failed");
    const result = await response.json();
    statusEl.textContent = t("status.saved");
    document.getElementById("voice-name").value = "";
    await loadSavedVoices();
    // 选中新保存的声音
    if (result && result.voice_id) {
      selectedVoiceId = result.voice_id;
    } else if (savedVoices.length > 0) {
      selectedVoiceId = savedVoices[savedVoices.length - 1].id;
    }
    renderVoiceList();
    // 折叠新建区域
    const details = document.getElementById("clone-new-section");
    if (details) details.removeAttribute("open");
  } catch (error) {
    statusEl.textContent = t("status.failed") + ": " + error.message;
  }
}

// ===== 录音 =====
async function toggleRecording() {
  const btn = document.getElementById("record-btn");
  const icon = document.getElementById("record-icon");
  const text = document.getElementById("record-text");
  const timer = document.getElementById("record-timer");

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recordedBlob = new Blob(audioChunks, { type: "audio/webm" });
        selectedFile = null;

        showAudioPreview(URL.createObjectURL(recordedBlob));

        icon.textContent = "🎙️";
        text.textContent = t("btn.record");
        timer.classList.add("hidden");
        btn.classList.remove("bg-red-500/20", "border-red-500");
        clearInterval(timerInterval);
      };

      mediaRecorder.start();
      recordingStartTime = Date.now();

      icon.innerHTML = '<div class="recording-indicator"></div>';
      text.textContent = t("btn.stopRecord");
      timer.classList.remove("hidden");
      timer.textContent = "00:00";
      btn.classList.add("bg-red-500/20", "border-red-500");

      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        timer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
      }, 100);
    } catch (err) {
      alert("无法访问麦克风: " + err.message);
    }
  } else if (mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (file) {
    selectedFile = file;
    recordedBlob = null;
    showAudioPreview(URL.createObjectURL(file));
  }
}

function showAudioPreview(url) {
  document.getElementById("audio-preview-section").classList.remove("hidden");
  document.getElementById("audio-preview").src = url;
  document.getElementById("save-voice-section").classList.remove("hidden");
}

function clearAudio() {
  recordedBlob = null;
  selectedFile = null;
  document.getElementById("audio-preview-section").classList.add("hidden");
  document.getElementById("audio-preview").src = "";
  document.getElementById("audio-file").value = "";
  document.getElementById("save-voice-section").classList.add("hidden");
}

// ===== 设计声音 =====
let designPreviewAudioBase64 = null; // 保存预览音频的 base64 数据

async function previewDesignVoice() {
  const desc = document.getElementById("voice-desc").value.trim();
  const text = document.getElementById("design-preview-text").value.trim();
  const language = document.getElementById("language-design").value;

  if (!desc) {
    document.getElementById("status-message").textContent = t("status.needDesc");
    return;
  }
  if (!text) {
    document.getElementById("status-message").textContent = t("status.enterText");
    return;
  }

  const btn = document.getElementById("design-preview-btn");
  const statusEl = document.getElementById("status-message");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle"></span> <span>${t("design.generating")}</span>`;

  // 确保 design 模型加载
  const modelReady = await ensureModelLoaded("design");
  if (!modelReady) {
    btn.disabled = false;
    btn.innerHTML = `<span>${t("design.preview")}</span>`;
    statusEl.innerHTML = `<span class="text-red-600">${t("status.failed")}</span>`;
    return;
  }

  try {
    const formData = new FormData();
    formData.append("text", text);
    formData.append("language", language);
    formData.append("instruct", desc);

    const response = await fetch("/voices/design-preview", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Preview failed");
    }
    const data = await response.json();
    designPreviewAudioBase64 = data.audio;

    // 显示预览播放器
    const binaryString = atob(data.audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/wav" });
    document.getElementById("design-preview-audio").src = URL.createObjectURL(blob);
    document.getElementById("design-preview-section").classList.remove("hidden");
    document.getElementById("design-save-section").classList.remove("hidden");
    statusEl.textContent = "";
  } catch (error) {
    statusEl.innerHTML = `<span class="text-red-600">${t("status.failed")}: ${error.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>${t("design.preview")}</span>`;
  }
}

function clearDesignPreview() {
  designPreviewAudioBase64 = null;
  document.getElementById("design-preview-audio").src = "";
  document.getElementById("design-preview-section").classList.add("hidden");
  document.getElementById("design-save-section").classList.add("hidden");
}

async function saveDesignVoice() {
  const name = document.getElementById("design-voice-name").value.trim();
  if (!name) return;
  if (!designPreviewAudioBase64) return;

  const desc = document.getElementById("voice-desc").value.trim();
  const text = document.getElementById("design-preview-text").value.trim();
  const language = document.getElementById("language-design").value;

  const statusEl = document.getElementById("status-message");
  statusEl.textContent = t("status.saving");

  try {
    const formData = new FormData();
    formData.append("name", name);
    formData.append("language", language);
    formData.append("instruct", desc);
    formData.append("text", text);
    formData.append("audio_base64", designPreviewAudioBase64);

    const response = await fetch("/voices/design-save", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Save failed");
    }
    const result = await response.json();
    statusEl.innerHTML = `<span class="text-green-600">${t("design.saveSuccess")}</span>`;

    // 清理设计表单
    document.getElementById("design-voice-name").value = "";
    clearDesignPreview();
    // 折叠设计区域
    const details = document.getElementById("design-new-section");
    if (details) details.removeAttribute("open");

    // 刷新声音库并选中新声音
    await loadSavedVoices();
    if (result && result.voice_id) {
      selectedVoiceId = result.voice_id;
    } else if (savedVoices.length > 0) {
      selectedVoiceId = savedVoices[savedVoices.length - 1].id;
    }
    renderVoiceList();
  } catch (error) {
    statusEl.innerHTML = `<span class="text-red-600">${t("status.failed")}: ${error.message}</span>`;
  }
}
