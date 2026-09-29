'use strict';

const vscode = acquireVsCodeApi();
const notice = document.getElementById('notice');
const buckets = document.getElementById('buckets');
const account = document.getElementById('account');
const refreshButton = document.getElementById('refresh');

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
document.getElementById('refreshSettings').addEventListener('click', () => vscode.postMessage({ command: 'refreshSettings' }));
document.getElementById('openUsage').addEventListener('click', () => vscode.postMessage({ command: 'openUsage' }));
window.addEventListener('message', event => {
  if (event.data && event.data.type === 'state') render(event.data.state);
});
vscode.postMessage({ command: 'ready' });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function render(state) {
  const { data, error, loading, updatedAt } = state;
  refreshButton.disabled = loading;
  refreshButton.textContent = loading ? '正在读取…' : '刷新额度';
  notice.replaceChildren();
  if (error) {
    notice.className = 'notice error';
    notice.append(el('strong', '', data && updatedAt ? '读取失败 · 上次数据' : '读取失败'));
    notice.append(el('p', '', error));
  } else if (loading) {
    notice.className = 'notice loading';
    notice.append(el('span', 'loading-dot'));
    notice.append(el('span', '', '正在向 Codex 读取额度…'));
  } else if (data && data.ordinaryUsageAllowed === false) {
    notice.className = 'notice warning';
    notice.append(el('strong', '', '普通额度当前不可用'));
    notice.append(el('p', '', '此状态由 Codex 返回；请以官方额度页面为准。'));
  } else {
    notice.className = 'notice subtle';
    notice.append(el('span', 'live-dot'));
    notice.append(el('span', '', updatedAt ? `更新于 ${time(updatedAt)}` : '等待首次读取'));
  }

  buckets.replaceChildren();
  if (!data || !data.buckets.length) {
    buckets.append(el('p', 'empty', data ? 'Codex 未提供可显示的额度窗口。' : '等待额度数据…'));
  } else {
    for (const bucket of data.buckets) buckets.append(renderBucket(bucket));
  }

  account.replaceChildren();
  if (data) {
    account.append(el('div', 'section-label', '当前账户'));
    const identity = el('div', 'identity');
    identity.append(el('strong', '', data.email || accountName(data.accountType)));
    if (data.plan) identity.append(el('span', 'plan', String(data.plan).toUpperCase()));
    account.append(identity);
    account.append(el('p', 'account-hint', data.accountType === 'apiKey'
      ? 'API Key 的限额与 ChatGPT 订阅额度不同。'
      : '通过 Codex App Server 读取；插件不接触登录令牌。'));
  }
}

function renderBucket(bucket) {
  const section = el('section', 'bucket');
  const heading = el('div', 'bucket-heading');
  heading.append(el('div', 'bucket-name', bucket.name));
  if (bucket.model) heading.append(el('div', 'bucket-model', bucket.model));
  section.append(heading);
  const windows = [bucket.primary, bucket.secondary].filter(Boolean);
  if (!windows.length) {
    section.append(el('p', 'empty', '此额度组暂未返回使用窗口。'));
  } else {
    windows.forEach((window, index) => section.append(renderWindow(window, index)));
  }
  if (bucket.reached) section.append(el('p', 'reached', 'Codex 报告该额度组已受限'));
  return section;
}

function renderWindow(window, index) {
  const row = el('div', `window ${index === 0 ? 'primary' : 'secondary'}`);
  const top = el('div', 'window-top');
  top.append(el('span', 'window-label', window.shortLabel || window.label));
  const track = el('div', 'track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `${window.label}剩余额度`);
  track.setAttribute('aria-valuenow', String(Math.round(window.remainingPercent)));
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const filled = Math.round(window.remainingPercent * 5 / 100);
  for (let i = 0; i < 5; i++) track.append(el('span', `segment${i < filled ? ' filled' : ''}`));
  top.append(track);
  const number = el('span', 'window-value');
  number.append(el('strong', '', `${Math.round(window.remainingPercent)}%`));
  top.append(number);
  row.append(top);
  row.append(el('div', 'reset', `下次重置：${resetText(window.resetsAt)}`));
  return row;
}

function time(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function resetText(ms) {
  if (!ms) return '未提供';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '未提供';
  const formatted = date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
  return ms <= Date.now() ? `已到 · ${formatted}` : formatted;
}

function accountName(type) {
  if (type === 'apiKey') return 'API Key 账户';
  if (type === 'chatgpt') return 'ChatGPT 账户';
  return '账户信息未提供';
}
