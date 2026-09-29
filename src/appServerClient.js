'use strict';

const { spawn } = require('node:child_process');

class AppServerClient {
  constructor(executable) {
    this.executable = executable;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.starting = null;
    this.disposed = false;
  }

  async start() {
    if (this.disposed) throw new Error('客户端已关闭');
    if (this.process && !this.process.killed && !this.starting) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } catch (error) {
      this.stopWithError(error);
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async startProcess() {
    const child = spawn(this.executable, ['app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    this.process = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    // stderr may contain private URLs or account details; never copy it to UI/logs.
    child.stderr.resume();
    child.stdin.on('error', () => this.stopWithError(new Error('Codex App Server 连接已断开')));
    child.on('error', () => this.stopWithError(new Error('无法启动 Codex App Server')));
    child.on('exit', () => this.stopWithError(new Error('Codex App Server 已退出')));

    await this.requestRaw('initialize', {
      clientInfo: { name: 'sugimoto-codex-quota-monitor', title: 'Codex Quota Monitor', version: '0.1.6' }
    }, 12000);
    this.notify('initialized', {});
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) {
      this.stopWithError(new Error('Codex App Server 响应过大'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) {
          const error = new Error(String(message.error.message || 'Codex 请求失败'));
          error.code = message.error.code;
          waiting.reject(error);
        } else {
          waiting.resolve(message.result);
        }
      } else if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        this.write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  }

  write(message) {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) throw new Error('Codex App Server 未运行');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ method, params });
  }

  requestRaw(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex App Server 请求超时'));
        this.stopWithError(new Error('Codex App Server 请求超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async read() {
    await this.start();
    const [accountResult, rateResult] = await Promise.allSettled([
      this.requestRaw('account/read', { refreshToken: false }),
      this.requestRaw('account/rateLimits/read')
    ]);
    if (rateResult.status === 'rejected') {
      const error = rateResult.reason;
      if (accountResult.status === 'fulfilled') error.account = accountResult.value;
      throw error;
    }
    return {
      account: accountResult.status === 'fulfilled' ? accountResult.value : null,
      rateLimits: rateResult.value
    };
  }

  stopWithError(error) {
    const child = this.process;
    this.process = null;
    this.buffer = '';
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    if (child && !child.killed) child.kill();
  }

  dispose() {
    this.disposed = true;
    this.stopWithError(new Error('客户端已关闭'));
  }
}

module.exports = { AppServerClient };
