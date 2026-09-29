'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clients = [];
const statusItems = [];
let pendingRead = false;
let configurationListener;
let themeListener;

class FakeClient {
  constructor() {
    this.disposed = false;
    clients.push(this);
  }

  read() {
    if (pendingRead) return new Promise((resolve, reject) => { this.rejectRead = reject; });
    return Promise.resolve({
      rateLimits: { rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300 },
        secondary: { usedPercent: 60, windowDurationMins: 10080 }
      } },
      account: { account: { type: 'chatgpt' } }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.rejectRead) this.rejectRead(new Error('客户端已关闭'));
  }
}

const statusItem = () => {
  const item = {
    visible: false,
    show() { this.visible = true; },
    hide() { this.visible = false; },
    dispose() {}
  };
  statusItems.push(item);
  return item;
};
const vscode = {
  StatusBarAlignment: { Right: 1 },
  ColorThemeKind: { Light: 1, Dark: 2 },
  MarkdownString: class { constructor(value) { this.value = value; } },
  window: {
    activeColorTheme: { kind: 1 },
    createStatusBarItem: statusItem,
    onDidChangeActiveColorTheme: listener => {
      themeListener = listener;
      return { dispose() {} };
    },
    registerWebviewViewProvider: () => ({ dispose() {} })
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => fallback }),
    onDidChangeConfiguration: listener => {
      configurationListener = listener;
      return { dispose() {} };
    }
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  extensions: { getExtension: () => null }
};

const originalLoad = Module._load;
let extension;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === './appServerClient' && parent.filename.endsWith('extension.js')) return { AppServerClient: FakeClient };
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../src/extension');
} finally {
  Module._load = originalLoad;
}

test('每次额度读取完成后释放 App Server 客户端', async () => {
  clients.length = 0;
  statusItems.length = 0;
  pendingRead = false;
  extension.activate({ subscriptions: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 1);
  assert.equal(clients[0].disposed, true);
  assert.equal(statusItems.length, 2);
  assert.equal(statusItems[0].visible, true);
  assert.equal(statusItems[1].visible, true);
  extension.deactivate();
});

test('扩展退出时释放正在读取的 App Server 客户端', async () => {
  clients.length = 0;
  pendingRead = true;
  extension.activate({ subscriptions: [] });
  assert.equal(clients.length, 1);
  extension.deactivate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients[0].disposed, true);
});

test('读取期间更改可执行文件会关闭旧客户端并用新客户端重读', async () => {
  clients.length = 0;
  pendingRead = true;
  extension.activate({ subscriptions: [] });
  assert.equal(clients.length, 1);
  pendingRead = false;
  configurationListener({ affectsConfiguration: key => key === 'codexQuota.codexExecutable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[1].disposed, true);
  extension.deactivate();
});

test('浅色主题区分两段额度颜色，切换深色主题时同步更新', async () => {
  clients.length = 0;
  statusItems.length = 0;
  pendingRead = false;
  vscode.window.activeColorTheme.kind = vscode.ColorThemeKind.Light;
  extension.activate({ subscriptions: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusItems[0].color, '#006b50');
  assert.equal(statusItems[1].color, '#1154ad');
  assert.equal(statusItems[0].tooltip, statusItems[1].tooltip);
  vscode.window.activeColorTheme.kind = vscode.ColorThemeKind.Dark;
  themeListener();
  assert.equal(statusItems[0].color, '#43d6af');
  assert.equal(statusItems[1].color, '#6ba9ff');
  extension.deactivate();
});
