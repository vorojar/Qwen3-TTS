// ===== 初始化 =====
document.addEventListener("DOMContentLoaded", () => {
  currentLang = localStorage.getItem("lang") || "zh";
  updateI18n();
  loadSavedVoices();
  updateCharCount();
  initProjectSystem(); // 项目系统初始化（含旧数据迁移）
});
