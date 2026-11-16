// content/recorder.js — 操作录制内容脚本
// 声明式注入所有页面；默认休眠，仅当所在标签页处于录制状态时才挂载监听。
(() => {
  let active = false;

  // ---------- 元素描述 ----------

  // 判断 id 是否稳定（排除 uuid / 纯数字 / 长随机串等自动生成 id）
  function isStableId(id) {
    if (!id || id.length > 40) return false;
    if (/^\d+$/.test(id)) return false;                    // 纯数字
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false; // uuid
    if (/^[a-z]*\d{6,}$/i.test(id)) return false;          // 前缀+长数字（react/scoped id 常见）
    return true;
  }

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // 从元素向上构造 tag:nth-of-type 路径，最多 4 层
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        const idx = same.indexOf(node) + 1;
        parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      } else {
        parts.unshift(tag);
      }
      if (node.id && isStableId(node.id)) {
        return '#' + cssEscape(node.id) + (parts.length ? ' > ' + parts.join(' > ') : '');
      }
      node = parent;
    }
    return parts.join(' > ');
  }

  // 生成元素语义描述：选择器按 testid > 稳定id > aria > 路径 优先
  function describeElement(el) {
    if (!el || el.nodeType !== 1) return {};
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    const aria = el.getAttribute('aria-label');
    const name = el.getAttribute('name');
    const placeholder = el.getAttribute('placeholder');
    let selector;
    if (testid) selector = `${tag}[data-testid="${testid}"]`;
    else if (el.id && isStableId(el.id)) selector = '#' + cssEscape(el.id);
    else if (aria) selector = `${tag}[aria-label="${aria}"]`;
    else if (name && tag !== 'input') selector = `${tag}[name="${name}"]`;
    else selector = cssPath(el);
    return {
      tag,
      selector,
      role: el.getAttribute('role'),
      // password 输入框的 value 绝不能进入 text（掩码只在 action.value 层，text 兜底曾泄漏明文）
      text: el.type === 'password' ? undefined : (el.innerText || el.value || '').trim().slice(0, 80) || undefined,
      testid: testid || undefined,
      aria: aria || undefined,
      name: name || undefined,
      placeholder: placeholder || undefined,
      type: el.getAttribute('type') || undefined,
    };
  }

  // ---------- 动作上报 ----------

  function sendAction(type, extra) {
    if (!active) return;
    chrome.runtime.sendMessage({
      type: 'rec:action',
      action: { type, ts: Date.now(), url: location.href, ...extra },
    }).catch(() => {}); // SW 休眠瞬间可能失败，忽略
  }

  // ---------- 监听器 ----------

  function onClick(e) {
    const el = e.target.closest('a, button, input, select, textarea, label, [role="button"], [onclick], summary, li, tr, div, span, p, h1, h2, h3, h4, svg') || e.target;
    sendAction('click', { element: describeElement(el) });
  }

  // 文本输入防抖：停止输入 800ms 后记录一次最终值
  let inputTimer = null;
  let inputTarget = null;
  function onInput(e) {
    const el = e.target;
    if (!el.matches || !el.matches('input, textarea')) return;
    inputTarget = el;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => flushInput(), 800);
  }

  function flushInput() {
    if (!inputTarget || !inputTarget.isConnected) return;
    const el = inputTarget;
    const masked = el.type === 'password';
    sendAction('input', {
      element: describeElement(el),
      value: masked ? '***' : (el.value || '').slice(0, 200),
    });
    inputTarget = null;
  }

  // select / checkbox / radio 立即记录
  function onChange(e) {
    const el = e.target;
    if (!el.matches || !el.matches('select, input[type="checkbox"], input[type="radio"]')) return;
    clearTimeout(inputTimer); // 避免 change 后又补一条过时的 input
    sendAction('input', {
      element: describeElement(el),
      value: el.type === 'checkbox' ? String(el.checked) : el.value,
    });
  }

  function onKeydown(e) {
    if (e.key !== 'Enter') return;
    sendAction('keypress', { key: 'Enter', element: describeElement(e.target) });
  }

  let lastScroll = 0;
  function onScroll() {
    const now = Date.now();
    if (now - lastScroll < 1000) return; // 节流：1s 内只记一次
    lastScroll = now;
    sendAction('scroll', { x: Math.round(scrollX), y: Math.round(scrollY) });
  }

  function onSubmit(e) {
    sendAction('submit', { element: describeElement(e.target) });
  }

  function mount() {
    if (active) return;
    active = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('submit', onSubmit, true);
  }

  function unmount() {
    if (!active) return;
    active = false;
    clearTimeout(inputTimer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('submit', onSubmit, true);
  }

  // ---------- 激活控制 ----------

  // 页面加载后询问后台：本标签页是否在录制（导航后自动恢复）
  chrome.runtime.sendMessage({ type: 'content:hello' }).then((res) => {
    if (res && res.recording) mount();
  }).catch(() => {});

  // 后台主动激活/停止（录制开始时页面已打开、录制结束时）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'rec:activate') { mount(); sendResponse({ ok: true }); }
    else if (msg.type === 'rec:deactivate') { unmount(); sendResponse({ ok: true }); }
  });
})();
