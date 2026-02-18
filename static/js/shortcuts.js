// ===== 键盘快捷键 =====
function isSentenceEditorVisible() {
  const pv = document.getElementById("progress-view");
  return (
    pv &&
    !pv.classList.contains("hidden") &&
    pv.querySelector(".sentence-editor-list")
  );
}

function isEditingText() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
  if (el.contentEditable === "true") return true;
  return false;
}

document.addEventListener("keydown", (e) => {
  // Ctrl+Z / Cmd+Z: 撤销（全局，不在输入框时）
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !isEditingText()) {
    if (isSentenceEditorVisible() && undoStack.length > 0) {
      e.preventDefault();
      undoRegenerate();
      return;
    }
  }

  // 以下快捷键仅在句子编辑视图可见时生效
  if (!isSentenceEditorVisible()) return;

  // 正在编辑句子文本时，只处理 Esc
  if (isEditingText()) {
    if (e.key === "Escape") {
      e.preventDefault();
      finishEditing();
    }
    return;
  }

  switch (e.key) {
    case " ": // 空格: 播放/暂停
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowUp": // ↑: 上一句
      e.preventDefault();
      if (selectedSentenceIndex > 0) {
        selectedSentenceIndex--;
      } else if (selectedSentenceIndex === -1 && sentenceTexts.length > 0) {
        selectedSentenceIndex = 0;
      }
      document.querySelectorAll(".sentence-editor-item").forEach((el, i) => {
        el.classList.toggle("selected", i === selectedSentenceIndex);
      });
      document
        .getElementById(`sent-item-${selectedSentenceIndex}`)
        ?.scrollIntoView({ block: "nearest" });
      break;
    case "ArrowDown": // ↓: 下一句
      e.preventDefault();
      if (selectedSentenceIndex < sentenceTexts.length - 1) {
        selectedSentenceIndex++;
      } else if (selectedSentenceIndex === -1 && sentenceTexts.length > 0) {
        selectedSentenceIndex = 0;
      }
      document.querySelectorAll(".sentence-editor-item").forEach((el, i) => {
        el.classList.toggle("selected", i === selectedSentenceIndex);
      });
      document
        .getElementById(`sent-item-${selectedSentenceIndex}`)
        ?.scrollIntoView({ block: "nearest" });
      break;
    case "Enter": // Enter: 重新生成选中句
      if (selectedSentenceIndex >= 0) {
        e.preventDefault();
        regenerateSentence(selectedSentenceIndex);
      }
      break;
    case "Escape": // Esc: 取消选中
      e.preventDefault();
      selectedSentenceIndex = -1;
      document
        .querySelectorAll(".sentence-editor-item")
        .forEach((el) => el.classList.remove("selected"));
      break;
    case "p": // P: 试听选中句
      if (selectedSentenceIndex >= 0) {
        e.preventDefault();
        previewSentenceAudio(selectedSentenceIndex);
      }
      break;
    case "Delete": // Delete: 删除选中句
    case "Backspace":
      if (selectedSentenceIndex >= 0) {
        e.preventDefault();
        deleteSentence(selectedSentenceIndex);
      }
      break;
  }
});
