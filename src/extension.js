'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { AppServerClient } = require('./appServerClient');
const { normalizeSnapshot, progressBar } = require('./model');

let controller;

class QuotaViewProvider {
  constructor(context, getState, refresh) {
    this.context = context;
    this.getState = getState;
    this.refresh = refresh;
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    webview.html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>Codex 额度</title></head>
<body><main class="shell">
  <header class="hero"><div class="eyebrow">CODEX / USAGE</div><h1>额度概览</h1>
    <p class="lead">来自本机 Codex 的当前账户数据</p></header>
  <div id="notice" class="notice" role="status" aria-live="polite"></div>
  <div id="buckets" class="buckets"></div>
  <div id="account" class="account"></div>
  <footer class="footer"><button id="refresh" type="button">刷新额度</button>
    <button id="refreshSettings" type="button" class="link-button">刷新间隔设置</button>
    <button id="openUsage" type="button" class="link-button">官方额度页面 ↗</button></footer>
</main><script src="${script}"></script></body></html>`;
    webview.onDidReceiveMessage(message => {
      if (message && message.command === 'ready') this.update();
      if (message && message.command === 'refresh') this.refresh();
      if (message && message.command === 'refreshSettings') vscode.commands.executeCommand('workbench.action.openSettings', 'codexQuota.refreshMinutes');
      if (message && message.command === 'openUsage') vscode.commands.executeCommand('codexQuota.openUsage');
    });
    view.onDidDispose(() => { this.view = null; });
  }

  update() {
    if (this.view) this.view.webview.postMessage({ type: 'state', state: this.getState() });
  }
}

class QuotaController {
  constructor(context) {
    this.context = context;
    this.client = null;
    this.refreshPromise = null;
    this.refreshAfterCurrent = false;
    this.disposed = false;
    this.timer = null;
    this.state = { loading: true, data: null, error: null, updatedAt: null };
    this.status = [
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    ];
    this.status[0].name = 'Codex 短周期剩余额度';
    this.status[1].name = 'Codex 长周期剩余额度';
    for (const item of this.status) {
      item.command = 'codexQuota.show';
      context.subscriptions.push(item);
    }
    this.status[0].show();
    this.view = new QuotaViewProvider(context, () => this.state, () => this.refresh());
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codexQuota.view', this.view));
    context.subscriptions.push(vscode.commands.registerCommand('codexQuota.show', () => vscode.commands.executeCommand('codexQuota.view.focus')));
    context.subscriptions.push(vscode.commands.registerCommand('codexQuota.refresh', () => this.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('codexQuota.openUsage', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/codex/settings/usage'));
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (this.disposed) return;
      if (event.affectsConfiguration('codexQuota.codexExecutable')) {
        if (this.client) this.client.dispose();
        if (this.refreshPromise) this.refreshAfterCurrent = true;
        else this.refresh();
      }
      if (event.affectsConfiguration('codexQuota.refreshMinutes')) this.schedule();
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => this.render()));
    this.render();
    this.schedule();
    this.refresh();
  }

  executable() {
    const configured = vscode.workspace.getConfiguration('codexQuota').get('codexExecutable', '').trim();
    if (configured) return configured;
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (extension) {
      const binary = process.platform === 'win32'
        ? path.join(extension.extensionPath, 'bin', 'windows-x86_64', 'codex.exe')
        : process.platform === 'darwin'
          ? path.join(extension.extensionPath, 'bin', process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64', 'codex')
          : path.join(extension.extensionPath, 'bin', process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64', 'codex');
      if (fs.existsSync(binary)) return binary;
    }
    return process.platform === 'win32' ? 'codex.exe' : 'codex';
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    const configured = Number(vscode.workspace.getConfiguration('codexQuota').get('refreshMinutes', 10));
    const minutes = Number.isFinite(configured) ? Math.max(1, Math.min(60, configured)) : 10;
    this.timer = setInterval(() => this.refresh(), minutes * 60_000);
  }

  async refresh() {
    if (this.disposed) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.state = { ...this.state, loading: true };
    this.render();
    this.refreshPromise = (async () => {
      const client = new AppServerClient(this.executable());
      this.client = client;
      try {
        const result = await client.read();
        if (this.disposed) return;
        const data = normalizeSnapshot(result.rateLimits, result.account);
        this.state = { loading: false, data, error: null, updatedAt: Date.now() };
      } catch (error) {
        if (this.disposed || this.refreshAfterCurrent) return;
        const account = error && error.account && error.account.account;
        const partial = account && !this.state.data ? {
          accountType: account.type || null,
          email: account.type === 'chatgpt' ? account.email || null : null,
          plan: account.type === 'chatgpt' ? account.planType || null : null,
          ordinaryUsageAllowed: null,
          buckets: []
        } : this.state.data;
        this.state = { ...this.state, data: partial, loading: false, error: friendlyError(error) };
      } finally {
        client.dispose();
        if (this.client === client) this.client = null;
      }
      this.render();
    })();
    try { await this.refreshPromise; } finally {
      this.refreshPromise = null;
      if (this.refreshAfterCurrent && !this.disposed) {
        this.refreshAfterCurrent = false;
        void this.refresh();
      }
    }
  }

  render() {
    const { data, error, loading, updatedAt } = this.state;
    const main = data && data.buckets.find(bucket => bucket.id === 'codex');
    const windows = main && [main.primary, main.secondary].filter(Boolean);
    let accessible = 'Codex 额度';
    const [first, second] = this.status;
    second.hide();
    first.color = undefined;
    second.color = undefined;
    if (loading && !data) {
      first.text = '$(sync~spin) Codex 额度';
      accessible = 'Codex 额度读取中';
    } else if (error) {
      first.text = '$(warning) Codex 额度异常';
      accessible = `Codex 额度异常：${error}`;
    } else if (data && data.ordinaryUsageAllowed === false) {
      first.text = '$(warning) Codex 额度受限';
      accessible = 'Codex 普通额度当前不可用';
    } else if (windows && windows.length) {
      const [primary, secondary] = windows;
      const icon = primary.remainingPercent <= 10 ? '$(warning)' : '$(pulse)';
      const themeKind = vscode.window.activeColorTheme.kind;
      const light = themeKind === vscode.ColorThemeKind.Light;
      const dark = themeKind === vscode.ColorThemeKind.Dark;
      first.text = `${icon} ${primary.shortLabel} ${progressBar(primary.remainingPercent)} ${Math.round(primary.remainingPercent)}%`;
      first.color = light ? '#006b50' : dark ? '#43d6af' : undefined;
      if (secondary) {
        second.text = `${secondary.shortLabel} ${progressBar(secondary.remainingPercent)} ${Math.round(secondary.remainingPercent)}%`;
        second.color = light ? '#1154ad' : dark ? '#6ba9ff' : undefined;
        second.show();
      }
      accessible = `Codex 剩余额度：${windows.map(window => `${window.label} ${Math.round(window.remainingPercent)}%`).join('，')}`;
    } else {
      first.text = '$(question) Codex 无额度数据';
      accessible = 'Codex 没有可显示的额度数据';
    }
    let tooltip;
    if (error) {
      tooltip = `Codex 额度不可用：${error}`;
    } else if (data && data.ordinaryUsageAllowed === false) {
      tooltip = 'Codex 报告普通额度当前不可用。点击查看详细面板。';
    } else if (windows && windows.length) {
      const details = windows.map(window => {
        const reset = window.resetsAt
          ? new Date(window.resetsAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
          : '未提供';
        return `| ${window.label} | **${Math.round(window.remainingPercent)}%** | ${Math.round(window.usedPercent)}% | ${reset} |`;
      });
      const updated = updatedAt ? `\n\n更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} · 点击打开面板` : '';
      tooltip = new vscode.MarkdownString(`**Codex 剩余额度**\n\n| 周期 | 剩余 | 已用 | 下次重置 |\n| :-- | --: | --: | :-- |\n${details.join('\n')}${updated}`);
    } else {
      tooltip = 'Codex 暂无额度窗口；点击查看账户和读取状态。';
    }
    for (const item of this.status) {
      item.tooltip = tooltip;
      item.accessibilityInformation = { label: accessible };
    }
    this.view.update();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.client) this.client.dispose();
    this.client = null;
  }
}

function friendlyError(error) {
  const message = String(error && error.message || '');
  if (error && error.code === -32601) return '当前 Codex 版本不支持额度读取接口。请更新 Codex 后刷新。';
  if (/\b401\b|unauthori[sz]ed/i.test(message)) return '额度接口返回 401：当前登录态无法读取额度。请在 Codex 中重新登录后刷新。';
  if (/\b403\b|forbidden/i.test(message)) return '额度接口返回 403：账户请求被拒绝。请检查 Codex 登录状态与当前网络。';
  if (/ENOENT|无法启动|not found/i.test(message)) return '找不到 Codex 可执行文件。请在设置中指定 codex.exe 的完整路径。';
  if (/超时|timed out/i.test(message)) return '额度读取超时。请检查网络或稍后刷新。';
  if (/已退出|未运行|EPIPE/i.test(message)) return 'Codex App Server 已退出。再次刷新会重新连接。';
  return '额度读取失败。请检查 Codex 登录状态，并尝试刷新。';
}

function activate(context) {
  controller = new QuotaController(context);
}

function deactivate() {
  if (controller) controller.dispose();
  controller = null;
}

module.exports = { activate, deactivate };
