import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

export interface ServerOptions {
  port: number;
  webDir?: string;
  defaultEffort?: string;
  dangerouslySkipPermissions?: boolean;
  workspaceRoot?: string;
  getWorkspaceRoot?: () => string | undefined;
  onStatusChange?: (status: { running: boolean; port: number; ip: string; clientCount: number }) => void;
  onActivity?: (event: ServerActivityEvent) => void;
}

export type ServerActivityEvent =
  | { type: 'client_connect'; ip: string; clientCount: number }
  | { type: 'client_disconnect'; clientCount: number }
  | { type: 'prompt_received'; text: string; effort: string; cwd: string }
  | { type: 'tool_update'; toolName: string; state: string; parameters?: any }
  | { type: 'turn_finished'; success: boolean; duration?: number; usage?: any }
  | { type: 'turn_error'; error: string }
  | { type: 'turn_cancelled' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  conversationId?: string;
  duration?: number;
  usage?: any;
  tools?: Array<{
    name: string;
    parameters?: any;
    output?: string;
    state: string;
    error?: string;
  }>;
}

/**
 * Cross-platform detection of Antigravity CLI binary (`agy`)
 */
export function resolveAgyBinary(): { command: string; exists: boolean; path?: string } {
  const isWin = process.platform === 'win32';
  const home = os.homedir();

  // 1. Check mise shims
  const miseShim = isWin
    ? path.join(home, '.local', 'share', 'mise', 'shims', 'agy.cmd')
    : path.join(home, '.local', 'share', 'mise', 'shims', 'agy');
  if (fs.existsSync(miseShim)) {
    return { command: miseShim, exists: true, path: miseShim };
  }

  // 2. Check local bin / npm global
  const candidatePaths: string[] = isWin
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm', 'agy.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      ]
    : [
        path.join(home, '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/usr/bin/agy',
      ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return { command: p, exists: true, path: p };
    }
  }

  // 3. Check system PATH via which (Unix) or where (Windows)
  try {
    const checker = isWin ? 'where agy' : 'which agy';
    const out = execSync(checker, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      const firstLine = out.split(/\r?\n/)[0].trim();
      if (firstLine) {
        return { command: firstLine, exists: true, path: firstLine };
      }
    }
  } catch {
    // Not found in PATH
  }

  // Fallback
  return { command: isWin ? 'agy.cmd' : 'agy', exists: false };
}

/**
 * Open URL in default web browser across Windows, macOS, and Linux
 */
export function openInDefaultBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd = '';
    let args: string[] = [];

    if (process.platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '""', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }

    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

export class RemoteServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private webDir: string;
  private defaultEffort: string;
  private dangerouslySkipPermissions: boolean;
  private workspaceRoot?: string;
  private getWorkspaceRoot?: () => string | undefined;
  private onStatusChange?: (status: { running: boolean; port: number; ip: string; clientCount: number }) => void;
  private onActivity?: (event: ServerActivityEvent) => void;

  private activeProcess: ChildProcess | null = null;
  private isTurnActive = false;
  private currentConversationId: string | null = null;
  private conversationHistory: ChatMessage[] = [];
  private clients = new Set<WebSocket>();

  constructor(options: ServerOptions) {
    this.port = options.port || 7788;
    this.webDir = options.webDir || path.join(__dirname, 'web');
    this.defaultEffort = options.defaultEffort || 'low';
    this.dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? true;
    this.workspaceRoot = options.workspaceRoot;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.onStatusChange = options.onStatusChange;
    this.onActivity = options.onActivity;
  }

  public setWorkspaceRoot(dir: string) {
    this.workspaceRoot = dir;
  }

  public getWorkspaceRootPath(): string {
    return this.getEffectiveCwd();
  }

  public getConversationHistory(): ChatMessage[] {
    return this.conversationHistory;
  }

  public getLanIp(): string {
    const interfaces = os.networkInterfaces();
    const candidates: string[] = [];
    const virtualNames = [
      'docker', 'br-', 'veth', 'vethernet', 'wsl', 'virtualbox', 'vmware',
      'hyper-v', 'tap', 'tun', 'utun', 'tailscale', 'zerotier', 'loopback', 'dummy'
    ];

    for (const name of Object.keys(interfaces)) {
      const lower = name.toLowerCase();
      if (virtualNames.some((v) => lower.includes(v))) {
        continue;
      }
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Prioritize standard 192.168.x.x
          if (addr.address.startsWith('192.168.')) {
            return addr.address;
          }
          candidates.push(addr.address);
        }
      }
    }

    // Secondary priority: 10.x.x.x or 172.x.x.x
    const privateIp = candidates.find(ip => ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip));
    if (privateIp) return privateIp;

    return candidates[0] || '127.0.0.1';
  }

  public getUrl(): string {
    return `http://${this.getLanIp()}:${this.port}`;
  }

  public isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  public start(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.isRunning()) {
        resolve(this.getUrl());
        return;
      }

      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
      this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        const clientIp = req.socket.remoteAddress || 'unknown';
        this.handleWsConnection(ws, clientIp);
      });
      this.wss.on('error', () => {
        // Handled via this.server.on('error')
      });

      this.server.on('error', (err: any) => {
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        const url = this.getUrl();
        this.notifyStatus();
        resolve(url);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.cancelCurrentTurn();

      if (this.wss) {
        for (const ws of this.clients) {
          try {
            ws.close();
          } catch {
            // Ignore
          }
        }
        this.clients.clear();
        this.wss.close();
        this.wss = null;
      }

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.notifyStatus();
          resolve();
        });
      } else {
        this.notifyStatus();
        resolve();
      }
    });
  }

  public clearHistory(): void {
    this.conversationHistory = [];
    this.currentConversationId = null;
    this.broadcast({ type: 'history_cleared' });
  }

  private notifyStatus() {
    if (this.onStatusChange) {
      this.onStatusChange({
        running: this.isRunning(),
        port: this.port,
        ip: this.getLanIp(),
        clientCount: this.clients.size,
      });
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS headers for local LAN access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // API endpoints
    if (pathname === '/api/info') {
      const agyStatus = resolveAgyBinary();
      const info = {
        ok: true,
        ip: this.getLanIp(),
        port: this.port,
        url: this.getUrl(),
        isTurnActive: this.isTurnActive,
        conversationId: this.currentConversationId,
        historyCount: this.conversationHistory.length,
        cwd: this.getEffectiveCwd(),
        platform: process.platform,
        agyFound: agyStatus.exists,
        agyPath: agyStatus.path || agyStatus.command,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
      return;
    }

    if (pathname === '/api/cancel' && req.method === 'POST') {
      const cancelled = this.cancelCurrentTurn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled }));
      return;
    }

    if (pathname === '/api/workspace') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cwd: this.getEffectiveCwd() }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const targetPath = (data.path || '').trim();
            if (!targetPath) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Path cannot be empty.' }));
              return;
            }
            const resolvedPath = path.resolve(targetPath);
            if (!fs.existsSync(resolvedPath)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Directory does not exist: ${resolvedPath}` }));
              return;
            }
            const stat = fs.statSync(resolvedPath);
            if (!stat.isDirectory()) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Path is not a directory: ${resolvedPath}` }));
              return;
            }

            this.setWorkspaceRoot(resolvedPath);
            this.broadcast({ type: 'workspace_changed', cwd: resolvedPath });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, cwd: resolvedPath }));
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message || 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    if (pathname === '/api/clear' && req.method === 'POST') {
      this.clearHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Static file serving from this.webDir
    let safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let filePath = path.join(this.webDir, safePath);

    // Security check: ensure path is within webDir
    if (!filePath.startsWith(this.webDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.webDir, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Web app not found.');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading file');
    }
  }

  private handleWsConnection(ws: WebSocket, clientIp: string) {
    this.clients.add(ws);
    this.notifyStatus();
    this.onActivity?.({ type: 'client_connect', ip: clientIp, clientCount: this.clients.size });

    // Send initial handshake state
    ws.send(
      JSON.stringify({
        type: 'init',
        payload: {
          ip: this.getLanIp(),
          port: this.port,
          cwd: this.getEffectiveCwd(),
          isTurnActive: this.isTurnActive,
          conversationId: this.currentConversationId,
          history: this.conversationHistory,
        },
      })
    );

    ws.on('message', (raw: string | Buffer) => {
      try {
        const message = JSON.parse(raw.toString());
        this.handleWsMessage(ws, message);
      } catch (err) {
        // Ignore malformed JSON
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.notifyStatus();
      this.onActivity?.({ type: 'client_disconnect', clientCount: this.clients.size });
    });

    ws.on('error', () => {
      this.clients.delete(ws);
      this.notifyStatus();
    });
  }

  private handleWsMessage(ws: WebSocket, msg: any) {
    const type = msg.type;

    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return;
    }

    if (type === 'get_history') {
      ws.send(
        JSON.stringify({
          type: 'history',
          payload: {
            history: this.conversationHistory,
            isTurnActive: this.isTurnActive,
          },
        })
      );
      return;
    }

    if (type === 'clear') {
      this.clearHistory();
      return;
    }

    if (type === 'cancel') {
      this.cancelCurrentTurn();
      return;
    }

    if (type === 'change_workspace') {
      const targetPath = (msg.path || '').trim();
      if (!targetPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'Workspace path cannot be empty.' }));
        return;
      }
      const resolvedPath = path.resolve(targetPath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        ws.send(JSON.stringify({ type: 'error', message: `Invalid directory path: ${resolvedPath}` }));
        return;
      }
      this.setWorkspaceRoot(resolvedPath);
      this.broadcast({ type: 'workspace_changed', cwd: resolvedPath });
      return;
    }

    if (type === 'prompt') {
      const text = (msg.text || '').trim();
      if (!text) {
        ws.send(JSON.stringify({ type: 'error', message: 'Prompt cannot be empty.' }));
        return;
      }

      if (this.isTurnActive) {
        ws.send(JSON.stringify({ type: 'error', message: 'An agent turn is already running. Please wait or cancel.' }));
        return;
      }

      this.executePrompt({
        text,
        effort: msg.effort || this.defaultEffort,
        continueSession: msg.continueSession ?? true,
        cwd: msg.cwd || this.getEffectiveCwd(),
      });
    }
  }

  private getEffectiveCwd(): string {
    if (this.workspaceRoot && fs.existsSync(this.workspaceRoot)) {
      return this.workspaceRoot;
    }
    if (this.getWorkspaceRoot) {
      const root = this.getWorkspaceRoot();
      if (root && fs.existsSync(root)) {
        return root;
      }
    }
    return process.cwd();
  }

  private getProxyEnv(): Record<string, string> {
    const proxyEnv: Record<string, string> = {};
    const stateFile = path.join(os.homedir(), '.config', 'proxy_state');

    let proxyUrl = process.env.http_proxy || process.env.all_proxy || '';
    if (!proxyUrl && fs.existsSync(stateFile)) {
      try {
        proxyUrl = fs.readFileSync(stateFile, 'utf8').trim();
      } catch {
        // Ignore
      }
    }

    if (proxyUrl) {
      proxyEnv['http_proxy'] = proxyUrl;
      proxyEnv['https_proxy'] = proxyUrl;
      proxyEnv['all_proxy'] = proxyUrl;
      proxyEnv['HTTP_PROXY'] = proxyUrl;
      proxyEnv['HTTPS_PROXY'] = proxyUrl;
      proxyEnv['ALL_PROXY'] = proxyUrl;
      proxyEnv['no_proxy'] = 'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12';
      proxyEnv['NO_PROXY'] = 'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12';
    }

    return proxyEnv;
  }

  private executePrompt(options: { text: string; effort: string; continueSession: boolean; cwd: string }) {
    this.isTurnActive = true;

    // Record user message
    const userMsgId = 'user-' + Date.now();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text: options.text,
      timestamp: Date.now(),
      conversationId: this.currentConversationId || undefined,
    };
    this.conversationHistory.push(userMsg);

    // Prepare assistant placeholder message
    const assistantMsgId = 'asst-' + Date.now();
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      timestamp: Date.now(),
      tools: [],
    };
    this.conversationHistory.push(assistantMsg);

    this.onActivity?.({
      type: 'prompt_received',
      text: options.text,
      effort: options.effort,
      cwd: options.cwd,
    });

    // Broadcast turn start
    this.broadcast({
      type: 'turn_started',
      payload: {
        userMsg,
        assistantMsgId,
      },
    });

    // Determine agy binary path
    const agyResolved = resolveAgyBinary();
    const agyBin = agyResolved.path || agyResolved.command;

    const args: string[] = ['-p', options.text, '--output-format', 'stream-json'];

    if (options.effort) {
      args.push('--effort', options.effort);
    }

    if (options.continueSession && (this.currentConversationId || this.conversationHistory.length > 2)) {
      if (this.currentConversationId) {
        args.push('--conversation', this.currentConversationId);
      } else {
        args.push('--continue');
      }
    }

    if (this.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    const env = {
      ...process.env,
      ...this.getProxyEnv(),
    };

    const isWin = process.platform === 'win32';
    const child = spawn(agyBin, args, {
      cwd: options.cwd,
      env,
      shell: isWin,
      windowsHide: true,
    });

    this.activeProcess = child;

    let stdoutBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          this.handleAgyEvent(parsed, assistantMsg);
        } catch {
          // Ignore non-JSON stream chunk
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const errText = chunk.toString('utf8');
      this.broadcast({
        type: 'agent_log',
        payload: { text: errText, stream: 'stderr' },
      });
    });

    child.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          this.handleAgyEvent(parsed, assistantMsg);
        } catch {
          // Ignore
        }
        stdoutBuffer = '';
      }

      this.isTurnActive = false;
      this.activeProcess = null;

      this.broadcast({
        type: 'turn_finished',
        payload: {
          assistantMsgId,
          code,
          signal,
          success: code === 0,
        },
      });

      this.onActivity?.({
        type: 'turn_finished',
        success: code === 0,
        duration: assistantMsg.duration,
        usage: assistantMsg.usage,
      });
    });

    child.on('error', (err) => {
      this.isTurnActive = false;
      this.activeProcess = null;
      assistantMsg.text += `\n\n**Error executing agent:** ${err.message}`;
      this.broadcast({
        type: 'turn_error',
        payload: {
          assistantMsgId,
          error: err.message,
        },
      });

      this.onActivity?.({
        type: 'turn_error',
        error: err.message,
      });
    });
  }

  private handleAgyEvent(event: any, assistantMsg: ChatMessage) {
    if (event.event === 'init') {
      if (event.conversation_id) {
        this.currentConversationId = event.conversation_id;
        assistantMsg.conversationId = event.conversation_id;
      }
      this.broadcast({
        type: 'conversation_init',
        payload: {
          conversationId: event.conversation_id,
          tools: event.init?.tools || [],
          cwd: event.init?.cwd,
        },
      });
      return;
    }

    if (event.event === 'step_update' && event.step_update) {
      const step = event.step_update;

      if (step.step_type === 'agent_response') {
        if (step.text_delta) {
          assistantMsg.text += step.text_delta;
          this.broadcast({
            type: 'text_delta',
            payload: {
              assistantMsgId: assistantMsg.id,
              delta: step.text_delta,
              fullText: assistantMsg.text,
            },
          });
        }
        if (step.usage) {
          assistantMsg.usage = step.usage;
          assistantMsg.duration = step.duration_seconds;
        }
      }

      if (step.step_type === 'tool') {
        if (!assistantMsg.tools) assistantMsg.tools = [];
        const toolIndex = assistantMsg.tools.findIndex((t) => t.name === step.tool_name && t.state === 'ACTIVE');

        if (step.state === 'ACTIVE') {
          assistantMsg.tools.push({
            name: step.tool_name,
            parameters: step.tool_info?.parameters,
            state: 'ACTIVE',
          });
          this.onActivity?.({
            type: 'tool_update',
            toolName: step.tool_name,
            state: 'ACTIVE',
            parameters: step.tool_info?.parameters,
          });
        } else if (step.state === 'DONE' || step.state === 'ERROR') {
          if (toolIndex !== -1) {
            assistantMsg.tools[toolIndex].state = step.state;
            assistantMsg.tools[toolIndex].output = step.tool_info?.output;
            assistantMsg.tools[toolIndex].error = step.tool_info?.error?.message;
          } else {
            assistantMsg.tools.push({
              name: step.tool_name,
              parameters: step.tool_info?.parameters,
              output: step.tool_info?.output,
              state: step.state,
              error: step.tool_info?.error?.message,
            });
          }
          this.onActivity?.({
            type: 'tool_update',
            toolName: step.tool_name,
            state: step.state,
          });
        }

        this.broadcast({
          type: 'tool_update',
          payload: {
            assistantMsgId: assistantMsg.id,
            tool: {
              name: step.tool_name,
              state: step.state,
              parameters: step.tool_info?.parameters,
              output: step.tool_info?.output,
              error: step.tool_info?.error?.message,
            },
            allTools: assistantMsg.tools,
          },
        });
      }

      this.broadcast({
        type: 'step_update',
        payload: { step },
      });
      return;
    }

    if (event.event === 'result' && event.result) {
      if (event.result.response && !assistantMsg.text) {
        assistantMsg.text = event.result.response;
      }
      assistantMsg.duration = event.result.duration_seconds;
      assistantMsg.usage = event.result.usage;

      this.broadcast({
        type: 'turn_result',
        payload: {
          assistantMsgId: assistantMsg.id,
          result: event.result,
        },
      });
    }
  }

  public cancelCurrentTurn(): boolean {
    if (this.activeProcess && this.isTurnActive) {
      try {
        if (process.platform === 'win32' && this.activeProcess.pid) {
          spawn('taskkill', ['/pid', this.activeProcess.pid.toString(), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          this.activeProcess.kill('SIGTERM');
          const proc = this.activeProcess;
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }, 1500);
        }
      } catch {
        // Ignore kill errors
      }
      this.isTurnActive = false;
      this.activeProcess = null;
      this.broadcast({ type: 'turn_cancelled' });
      this.onActivity?.({ type: 'turn_cancelled' });
      return true;
    }
    return false;
  }

  public broadcast(data: any) {
    const raw = JSON.stringify(data);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(raw);
        } catch {
          // Ignore send error
        }
      }
    }
  }
}
