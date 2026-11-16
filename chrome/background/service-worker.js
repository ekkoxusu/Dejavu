// background/service-worker.js — 状态管理 + webRequest 监听 + 截图 + 消息中枢
// 状态存 chrome.storage.session（SW 可能被杀，重启后从存储恢复）；
// 所有修改走串行队列，避免并发读改写丢失数据。

// ---------- 侧边栏开关（点击图标：未开则开，已开则关） ----------

// 通过长连接跟踪各窗口侧边栏是否打开：面板页面加载时连接并上报 windowId，面板关闭时端口自动断开
const panelWindows = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  port.onMessage.addListener((msg) => {
    if (msg.windowId == null) return;
    panelWindows.add(msg.windowId);
    port.onDisconnect.addListener(() => panelWindows.delete(msg.windowId));
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (panelWindows.has(tab.windowId)) {
    // 已打开 → 关闭：Chrome 未提供 close API，用「禁用再启用该窗口面板」使其收起
    await chrome.sidePanel.setOptions({ windowId: tab.windowId, enabled: false });
    await chrome.sidePanel.setOptions({ windowId: tab.windowId, enabled: true });
  } else {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

const TOKEN_HEADERS = ['authorization', 'x-token', 'x-auth-token', 'x-access-token', 'access-token', 'token', 'x-api-key'];
const MAX_TOKENS = 50;
const MAX_NETWORK = 500;
const MAX_HISTORY = 10; // 录制历史保留条数（FIFO 淘汰最旧）

let state = null;          // { tokenWatch: {tabId, tokens[]}|null, recording: {...}|null }
let statePromise = null;   // 进行中的加载（记忆化，防止并发加载出两个 state 对象）
let queue = Promise.resolve(); // 串行化状态修改，防止交错写

// ---------- 状态读写 ----------

// 读取状态（SW 重启后内存为空，从 storage.session 恢复；并发调用共享同一次加载）
function getState() {
  if (!statePromise) {
    statePromise = chrome.storage.session.get(['tokenWatch', 'recording']).then(stored => {
      state = { tokenWatch: stored.tokenWatch || null, recording: stored.recording || null };
      return state;
    });
  }
  return statePromise;
}

// 在串行队列中执行状态修改并持久化；任务间错误隔离，链不断
function mutate(fn) {
  const run = queue.then(async () => {
    const s = await getState();
    const result = await fn(s);
    try {
      await chrome.storage.session.set({ tokenWatch: s.tokenWatch, recording: s.recording });
    } catch (e) {
      // session 存储 10MB 配额超限：丢弃最新动作的截图后重试一次
      const rec = s.recording;
      if (rec && rec.actions.length && rec.actions[rec.actions.length - 1].screenshot) {
        rec.actions[rec.actions.length - 1].screenshot = null;
        rec.screenshotsDropped = true;
        await chrome.storage.session.set({ recording: rec });
      }
    }
    return result;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

// 广播给侧边栏（侧边栏可能未打开，忽略错误）
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- 录制历史（storage.local，跨浏览器会话保留） ----------

// 归档一条已结束的会话，超过上限淘汰最旧
async function saveToHistory(rec) {
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  recordings.push(rec);
  while (recordings.length > MAX_HISTORY) recordings.shift();
  await chrome.storage.local.set({ recordings });
}

// 历史摘要（不含动作/截图大数组，避免整包传输）
function historySummary(r) {
  return {
    id: r.startedAt, startedAt: r.startedAt, endedAt: r.endedAt,
    startUrl: r.startUrl, title: r.title,
    actionCount: r.actions.length, networkCount: r.network.length,
    screenshotCount: r.actions.filter(a => a.screenshot).length,
  };
}

// 结束并归档当前会话：置 inactive → 存历史 → 清空 active 引用 → 广播
async function archiveRecording(s) {
  const rec = s.recording;
  if (!rec) return;
  rec.active = false;
  rec.endedAt = Date.now();
  chrome.tabs.sendMessage(rec.tabId, { type: 'rec:deactivate' }).catch(() => {});
  await saveToHistory(rec);
  s.recording = null; // 归档后允许直接开新录制
  broadcast({ type: 'rec:archived', id: rec.startedAt });
}

// ---------- webRequest（顶层注册，MV3 SW 重启后仍能被事件唤醒） ----------

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    mutate(async (s) => {
      if (!details.url.startsWith('http')) return;
      const headers = details.requestHeaders || [];
      // token 监控：提取 token 样式请求头
      if (s.tokenWatch && s.tokenWatch.tabId === details.tabId) {
        for (const h of headers) {
          if (!TOKEN_HEADERS.includes(h.name.toLowerCase()) || !h.value) continue;
          const dup = s.tokenWatch.tokens.some(t => t.header === h.name && t.value === h.value);
          if (!dup && s.tokenWatch.tokens.length < MAX_TOKENS) {
            s.tokenWatch.tokens.push({
              header: h.name, value: h.value,
              url: details.url, method: details.method, ts: Date.now(),
            });
            broadcast({ type: 'token:update', tokens: s.tokenWatch.tokens });
          }
        }
      }
      // 录制：记录请求摘要（auth 头掩码）
      if (s.recording && s.recording.tabId === details.tabId && s.recording.network.length < MAX_NETWORK) {
        const auth = headers.find(h => TOKEN_HEADERS.includes(h.name.toLowerCase()));
        s.recording.network.push({
          id: details.requestId, method: details.method, url: details.url,
          type: details.type, ts: Date.now(),
          auth: auth ? auth.value.slice(0, 12) + '***' : undefined,
        });
      }
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// 请求完成：回填 status
chrome.webRequest.onCompleted.addListener(
  (details) => {
    mutate(async (s) => {
      const rec = s.recording;
      if (!rec || rec.tabId !== details.tabId) return;
      const entry = rec.network.find(n => n.id === details.requestId && n.url === details.url && n.status === undefined);
      if (entry) entry.status = details.statusCode;
    });
  },
  { urls: ['<all_urls>'] }
);

// ---------- 导航与标签页生命周期 ----------

// 录制标签页加载完成：插入 navigate 动作（SPA 软导航由各动作携带的 url 变化体现）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  mutate(async (s) => {
    const rec = s.recording;
    if (!rec || rec.tabId !== tabId) return;
    rec.actions.push({
      seq: rec.actions.length, type: 'navigate', ts: Date.now(),
      url: tab.url, title: tab.title || undefined,
    });
    broadcast({ type: 'rec:update', action: rec.actions[rec.actions.length - 1], networkCount: rec.network.length });
  });
});

// 录制跟随标签页激活：用户切换标签页 / window.open 新页面时，把录制焦点移过去
chrome.tabs.onActivated.addListener(({ tabId }) => {
  mutate(async (s) => {
    const rec = s.recording;
    if (!rec || !rec.active || rec.tabId === tabId) return;
    chrome.tabs.sendMessage(rec.tabId, { type: 'rec:deactivate' }).catch(() => {}); // 旧标签页停止监听
    rec.tabId = tabId;
    const tab = await chrome.tabs.get(tabId);
    rec.actions.push({
      seq: rec.actions.length, type: 'tab', ts: Date.now(),
      url: tab.url, title: tab.title || undefined,
    });
    broadcast({ type: 'rec:update', action: rec.actions[rec.actions.length - 1], networkCount: rec.network.length });
    chrome.tabs.sendMessage(tabId, { type: 'rec:activate' }).catch(() => {}); // chrome:// 等页面无内容脚本
  });
});

// 标签页关闭：Chrome 会自动激活相邻标签页，录制由 onActivated 跟随迁移，这里只清理 token 监控
chrome.tabs.onRemoved.addListener((tabId) => {
  mutate(async (s) => {
    if (s.tokenWatch && s.tokenWatch.tabId === tabId) {
      s.tokenWatch = null;
      broadcast({ type: 'token:status', active: false });
    }
  });
});

// ---------- 消息处理 ----------

async function handle(msg, sender) {
  switch (msg.type) {
    // 只读：新页面加载，告知本标签页是否在录制
    case 'content:hello': {
      const s = await getState();
      return { recording: !!(s.recording && s.recording.active && sender.tab && s.recording.tabId === sender.tab.id) };
    }

    case 'token:start':
      return mutate(s => { s.tokenWatch = { tabId: msg.tabId, tokens: [] }; return { ok: true }; });

    case 'token:stop':
      return mutate(s => { s.tokenWatch = null; return { ok: true }; });

    case 'token:get': {
      const s = await getState();
      return { active: !!s.tokenWatch, tokens: s.tokenWatch ? s.tokenWatch.tokens : [] };
    }

    case 'rec:start':
      return mutate(async (s) => {
        const tab = await chrome.tabs.get(msg.tabId);
        s.recording = {
          active: true, tabId: msg.tabId, startedAt: Date.now(),
          startUrl: tab.url, title: tab.title, actions: [], network: [],
        };
        s.recording.actions.push({ seq: 0, type: 'navigate', ts: Date.now(), url: tab.url, title: tab.title });
        // 通知已加载的内容脚本开始监听（chrome:// 等页面无内容脚本，忽略错误）
        chrome.tabs.sendMessage(msg.tabId, { type: 'rec:activate' }).catch(() => {});
        return { ok: true };
      });

    case 'rec:stop':
      return mutate((s) => archiveRecording(s).then(() => ({ ok: true })));

    case 'history:list': {
      const { recordings = [] } = await chrome.storage.local.get('recordings');
      return { recordings: recordings.map(historySummary) };
    }

    case 'history:get': {
      const { recordings = [] } = await chrome.storage.local.get('recordings');
      return { recording: recordings.find(r => r.startedAt === msg.id) || null };
    }

    case 'rec:get': {
      const s = await getState();
      return { recording: s.recording };
    }

    case 'rec:action':
      return mutate(async (s) => {
        const rec = s.recording;
        if (!rec || !rec.active) return { ok: false };
        const action = { seq: rec.actions.length, ...msg.action };
        rec.actions.push(action);
        // 截图（失败或配额降级则跳过，不影响动作记录）
        try {
          if (!rec.screenshotsDropped) {
            const tab = await chrome.tabs.get(rec.tabId);
            if (!tab.active) throw new Error('recording tab not visible'); // captureVisibleTab 只能截前台，防错截其他页面
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
            action.screenshot = dataUrl.slice(dataUrl.indexOf(',') + 1); // 存纯 base64
          }
        } catch (e) { /* 页面不可见等情况 */ }
        broadcast({ type: 'rec:update', action, networkCount: rec.network.length });
        return { ok: true };
      });
  }
  return { error: 'unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch(err => sendResponse({ error: String(err && err.message || err) }));
  return true; // 异步回复
});
