// popup.js — 点击工具栏图标的下拉框，二次点击打开侧边栏
// （open_panel_on_action_click 在部分环境不生效，统一走显式打开）
document.getElementById('open-btn').onclick = async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
};
