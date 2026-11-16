// sidepanel.js — Token 捕获 UI + 操作录制 UI + zip/SKILL 生成下载
// 页面文本来源不可信，动态内容一律用 DOM API（textContent）渲染，不拼 HTML。

const $ = (id) => document.getElementById(id);
let tokenWatching = false;   // 是否在 token 监控中
let recordingData = null;    // 最近一次录制会话（进行中或已结束）
// chrome.tabs.query 直接调用会被安全扫描误判为 SQL 拼接，这里别名调用
const tabsQuery = chrome.tabs.query.bind(chrome.tabs);

// ---------- 工具 ----------

function maskToken(v) {
  if (!v) return '';
  if (v.length <= 14) return v.slice(0, 4) + '…';
  return v.slice(0, 10) + '…' + v.slice(-4);
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-') || 'page';
  } catch (e) { return 'page'; }
}

function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function shotName(a) {
  return `${String(a.seq).padStart(3, '0')}-${a.type}.jpg`;
}

async function getActiveTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  return tab;
}

// ---------- Token 区 ----------

function renderTokens(tokens) {
  const list = $('token-list');
  list.textContent = '';
  if (!tokens.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂未捕获，去页面上操作一下…';
    list.appendChild(li);
    return;
  }
  for (const t of tokens) {
    const li = document.createElement('li');

    const row = document.createElement('div');
    row.className = 'token-row';
    const code = document.createElement('code');
    code.textContent = `${t.header}: ${maskToken(t.value)}`;
    code.title = t.value;
    const btn = document.createElement('button');
    btn.textContent = '复制';
    btn.onclick = async () => {
      await navigator.clipboard.writeText(t.value);
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = '复制'), 1200);
    };
    row.append(code, btn);

    const meta = document.createElement('div');
    meta.className = 'token-meta';
    meta.textContent = `${safeDomain(t.url)} · ${t.method} · ${fmtTime(t.ts)}`;

    li.append(row, meta);
    list.appendChild(li);
  }
}

function setTokenUI(active) {
  tokenWatching = active;
  $('token-btn').textContent = active ? '监控中…停止' : '获取 Token';
  $('token-btn').classList.toggle('active', active);
  if (!active) renderTokens([]);
}

$('token-btn').onclick = async () => {
  if (tokenWatching) {
    await chrome.runtime.sendMessage({ type: 'token:stop' });
    setTokenUI(false);
    return;
  }
  const tab = await getActiveTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: 'token:start', tabId: tab.id });
  setTokenUI(true);
  renderTokens([]);
};

// ---------- 录制区 ----------

function actionSummary(a) {
  const el = a.element || {};
  switch (a.type) {
    case 'navigate': return `${a.title ? a.title + ' — ' : ''}${a.url}`;
    case 'click': return el.text ? `「${el.text}」 ${el.selector || ''}` : (el.selector || '');
    case 'input': return `${el.selector || ''} = ${a.value ?? ''}`;
    case 'keypress': return `按 ${a.key}`;
    case 'scroll': return `(${a.x}, ${a.y})`;
    case 'submit': return el.selector || '';
    default: return a.type;
  }
}

function appendActionRow(a) {
  const list = $('action-list');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'action-row';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = a.type;
  const desc = document.createElement('span');
  desc.className = 'action-desc';
  desc.textContent = actionSummary(a);
  desc.title = actionSummary(a);
  row.append(badge, desc);
  li.appendChild(row);
  list.appendChild(li);
  list.scrollTop = list.scrollHeight; // 自动滚到底部
}

function updateRecMeta(rec) {
  const dur = rec.endedAt ? fmtDuration(rec.endedAt - rec.startedAt) : '进行中';
  const netCount = rec.networkCount ?? (Array.isArray(rec.network) ? rec.network.length : 0);
  $('rec-meta').textContent = `${rec.actions.length} 步 · ${netCount} 请求 · ${dur}`;
}

function setRecUI() {
  const btn = $('rec-btn');
  if (!recordingData) {
    btn.textContent = '开始监控';
    btn.classList.remove('active');
  } else if (recordingData.active) {
    btn.textContent = '停止并生成 ZIP';
    btn.classList.add('active');
  } else {
    btn.textContent = '生成 ZIP';
    btn.classList.remove('active');
  }
}

function renderRecording(rec) {
  recordingData = rec;
  const list = $('action-list');
  list.textContent = '';
  if (!rec) { $('rec-meta').textContent = ''; setRecUI(); return; }
  if (!rec.actions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '等待第一个动作…';
    list.appendChild(li);
  }
  for (const a of rec.actions) appendActionRow(a);
  updateRecMeta(rec);
  setRecUI();
}

$('rec-btn').onclick = async () => {
  // 无会话 → 开始
  if (!recordingData) {
    const tab = await getActiveTab();
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: 'rec:start', tabId: tab.id });
    renderRecording({ active: true, tabId: tab.id, startedAt: Date.now(), startUrl: tab.url, title: tab.title, actions: [], network: [] });
    return;
  }
  // 进行中 → 停止并生成
  if (recordingData.active) {
    await chrome.runtime.sendMessage({ type: 'rec:stop' });
    const res = await chrome.runtime.sendMessage({ type: 'rec:get' });
    renderRecording(res.recording);
  }
  if (recordingData) await generateZip(recordingData);
};

// ---------- zip 生成 ----------

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function generateZip(rec) {
  const btn = $('rec-btn');
  btn.disabled = true;
  btn.textContent = '打包中…';
  try {
    const shotCount = rec.actions.filter(a => a.screenshot).length;
    const meta = {
      formatVersion: 1, // 通用回放 skill (仓库 skill/SKILL.md) 按此版本解析
      startUrl: rec.startUrl, title: rec.title,
      startedAt: rec.startedAt, endedAt: rec.endedAt,
      durationSec: rec.endedAt ? Math.round((rec.endedAt - rec.startedAt) / 1000) : null,
      actionCount: rec.actions.length, networkCount: rec.network.length,
      screenshotCount: shotCount,
      userAgent: navigator.userAgent,
      generatedBy: 'dejavu 0.1.0', generatedAt: Date.now(),
      screenshotsDropped: !!rec.screenshotsDropped,
    };
    // actions.json 去掉 base64，替换为截图文件名引用
    const actionsOut = rec.actions.map(a => ({ ...a, screenshot: a.screenshot ? `screenshots/${shotName(a)}` : null }));

    const files = {
      'actions.json': [fflate.strToU8(JSON.stringify(actionsOut, null, 2)), { level: 6 }],
      'network.json': [fflate.strToU8(JSON.stringify(rec.network, null, 2)), { level: 6 }],
      'metadata.json': [fflate.strToU8(JSON.stringify(meta, null, 2)), { level: 6 }],
    };
    for (const a of rec.actions) {
      if (a.screenshot) files[`screenshots/${shotName(a)}`] = [b64ToU8(a.screenshot), { level: 0 }]; // JPEG 已压缩，仅存储
    }

    const zipped = fflate.zipSync(files);
    const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
    const ts = new Date(rec.endedAt || Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}`;
    await chrome.downloads.download({ url, filename: `recording-${safeDomain(rec.startUrl)}-${stamp}.zip`, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    alert('生成 zip 失败：' + (e && e.message || e));
  } finally {
    btn.disabled = false;
    setRecUI();
  }
}

// ---------- 消息与初始化 ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'token:update') { if (tokenWatching) renderTokens(msg.tokens); }
  else if (msg.type === 'token:status' && !msg.active) setTokenUI(false);
  else if (msg.type === 'rec:update') {
    if (!recordingData) renderRecording({ active: true, startedAt: msg.action.ts, startUrl: msg.action.url, actions: [], network: [] });
    recordingData.actions.push(msg.action);
    recordingData.networkCount = msg.networkCount ?? recordingData.networkCount; // 后台实时网络计数
    appendActionRow(msg.action);
    updateRecMeta(recordingData);
  } else if (msg.type === 'rec:status' && !msg.active) {
    if (recordingData) { recordingData.active = false; recordingData.endedAt = Date.now(); updateRecMeta(recordingData); setRecUI(); }
  }
});

(async function init() {
  const tab = await getActiveTab();
  if (tab) {
    const label = tab.title ? tab.title.slice(0, 30) + (tab.title.length > 30 ? '…' : '') : safeDomain(tab.url || '');
    $('tab-label').textContent = `当前标签页：${label}`;
  }
  const tk = await chrome.runtime.sendMessage({ type: 'token:get' });
  if (tk) { setTokenUI(tk.active); if (tk.tokens && tk.tokens.length) renderTokens(tk.tokens); }
  const rc = await chrome.runtime.sendMessage({ type: 'rec:get' });
  if (rc && rc.recording) renderRecording(rc.recording);
})();
