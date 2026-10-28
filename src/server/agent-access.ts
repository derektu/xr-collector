import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { CollectorError } from '../core/types.js';
import { AGENT_PORT_RANGE } from '../runtime/agent-connection-defaults.js';
import { startServer, type RunningServer, type StartServerOptions } from './start.js';

export type AgentPortSetting = { mode: 'auto' } | { mode: 'fixed'; port: number };
export interface AgentConnection { url: string; token: string }
export interface AgentConnectionStatus {
  state: 'available' | 'unavailable'; activeUrl: string | null; activePort: number | null;
  configured: AgentPortSetting; restartRequired: boolean; message: string;
}
export interface AgentConnectionAccess {
  status(): AgentConnectionStatus;
  connection(): AgentConnection;
  configure(setting: AgentPortSetting): Promise<AgentConnectionStatus>;
  resetKey(): Promise<AgentConnection>;
  download(): Promise<Buffer>;
  authorize(header: string | undefined): boolean;
}
interface SavedAgentSettings { schemaVersion: 1; token: string; port: AgentPortSetting }

/** Owns the private Agent credential, configured port and active listener snapshot for one profile. */
class AgentConnectionService implements AgentConnectionAccess {
  private configured: AgentPortSetting = { mode: 'auto' };
  private activeConfigured: AgentPortSetting = { mode: 'auto' };
  private token = '';
  private server: RunningServer | null = null;
  private unavailableMessage = 'AI 助理連線尚未啟動。';
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly settingsFile: string, private readonly skillPath: string, private readonly autoStartPort: number,
    private readonly protectSecret?: (secret: string) => void,
    private readonly event?: (severity: 'info' | 'warning' | 'error', type: string, message: string, code?: string) => void) {}

  async open(): Promise<void> {
    let saved: SavedAgentSettings | null = null;
    try { saved = parseSettings(await readFile(this.settingsFile, 'utf8')); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') throw error;
      // The app is not released yet: discard an incompatible local format instead of carrying a migration layer.
      if (!code) await rm(this.settingsFile, { force: true });
    }
    this.configured = saved?.port ?? { mode: 'auto' };
    this.activeConfigured = clonePort(this.configured);
    this.token = saved?.token ?? randomBytes(32).toString('hex');
    this.protectSecret?.(this.token);
    if (!saved) await this.save({ schemaVersion: 1, token: this.token, port: this.configured });
    else await chmod(this.settingsFile, 0o600);
  }

  async start(options: Omit<StartServerOptions, 'port' | 'agentAuthorize' | 'agentConnection'>): Promise<void> {
    const candidates = this.activeConfigured.mode === 'fixed' ? [this.activeConfigured.port]
      : [...Array.from({ length: AGENT_PORT_RANGE }, (_, offset) => this.autoStartPort + offset), 0];
    try {
      this.server = await firstFreePort(candidates, (port) => startServer({ ...options, port,
        agentAuthorize: (header) => this.authorize(header), agentConnection: this }));
      this.unavailableMessage = '';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'agent_connection_failed';
      this.unavailableMessage = this.activeConfigured.mode === 'fixed'
        ? `指定的連線埠 ${this.activeConfigured.port} 無法使用。XR Collector 其他功能仍可使用，請修改連線設定後重新啟動。`
        : 'AI 助理連線無法啟動。XR Collector 其他功能仍可使用。';
      this.event?.('error', 'device.agent_connection_unavailable', this.unavailableMessage, code);
    }
  }

  status(): AgentConnectionStatus { return {
    state: this.server ? 'available' : 'unavailable', activeUrl: this.server?.url ?? null, activePort: this.server?.port ?? null,
    configured: clonePort(this.configured), restartRequired: !samePort(this.configured, this.activeConfigured),
    message: this.server ? 'AI 助理可從本機連線。' : this.unavailableMessage,
  }; }
  connection(): AgentConnection {
    if (!this.server) throw new CollectorError('agent_connection_unavailable', this.unavailableMessage);
    return { url: this.server.url, token: this.token };
  }
  configure(setting: AgentPortSetting): Promise<AgentConnectionStatus> {
    const validated = validatePortSetting(setting);
    return this.serial(async () => {
      await this.save({ schemaVersion: 1, token: this.token, port: validated });
      this.configured = clonePort(validated);
      this.event?.('info', 'device.agent_connection_configured', validated.mode === 'auto'
        ? 'AI 助理連線已設為自動選擇連線埠，下次啟動套用。' : `AI 助理連線已指定連線埠 ${validated.port}，下次啟動套用。`);
      return this.status();
    });
  }
  resetKey(): Promise<AgentConnection> { return this.serial(async () => {
    if (!this.server) throw new CollectorError('agent_connection_unavailable', this.unavailableMessage);
    const next = randomBytes(32).toString('hex');
    await this.save({ schemaVersion: 1, token: next, port: this.configured });
    this.token = next; this.protectSecret?.(next);
    this.event?.('warning', 'device.agent_connection_key_reset', 'AI 助理連線金鑰已重設，既有連線資料已失效。');
    return this.connection();
  }); }
  authorize(header: string | undefined): boolean { const supplied = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${this.token}`); return supplied.length === expected.length && timingSafeEqual(supplied, expected); }
  async download(): Promise<Buffer> {
    const skill = await readFile(path.join(this.skillPath, 'SKILL.md'));
    return zipFiles([{ name: 'xr-collector-agent/SKILL.md', data: skill },
      { name: 'xr-collector-agent/connection.json', data: Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...this.connection() }, null, 2)}\n`) }]);
  }
  async close(): Promise<void> { await this.server?.close(); this.server = null; }
  fail(message: string): void { this.unavailableMessage = message; }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.writes.then(work, work); this.writes = result.then(() => undefined, () => undefined); return result; }
  private async save(settings: SavedAgentSettings): Promise<void> {
    const temporary = `${this.settingsFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try { await mkdir(path.dirname(this.settingsFile), { recursive: true }); await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.settingsFile); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

export async function startAgentAccess(options: {
  buildInfo?: StartServerOptions['buildInfo']; collector?: StartServerOptions['collector']; jobs?: StartServerOptions['jobs']; activity?: StartServerOptions['activity']; protectSecret?: (secret: string) => void;
  transfer?: StartServerOptions['transfer']; subscriptions?: StartServerOptions['subscriptions']; schedule?: StartServerOptions['schedule']; search?: StartServerOptions['search'];
  pacing?: StartServerOptions['pacing']; connectivity?: StartServerOptions['connectivity']; preferredPort: number; settingsFile: string; skillPath: string;
  runtimeStatus?: StartServerOptions['runtimeStatus']; notReady?: StartServerOptions['notReady']; vaultSetup?: StartServerOptions['vaultSetup'];
  loginStartup?: StartServerOptions['loginStartup']; event?: (severity: 'info' | 'warning' | 'error', type: string, message: string, code?: string) => void;
  updates?: StartServerOptions['updates'];
}): Promise<AgentConnectionService> {
  const service = new AgentConnectionService(options.settingsFile, options.skillPath, options.preferredPort, options.protectSecret, options.event);
  try { await service.open(); }
  catch {
    const message = 'AI 助理連線設定無法讀取或保存。XR Collector 其他功能仍可使用。';
    service.fail(message);
    options.event?.('error', 'device.agent_connection_unavailable', message, 'agent_settings_failed');
    return service;
  }
  const { settingsFile: _a, skillPath: _b, preferredPort: _c, protectSecret: _d, event: _e, ...server } = options;
  await service.start(server as Omit<StartServerOptions, 'port' | 'agentAuthorize' | 'agentConnection'>); return service;
}
function parseSettings(text: string): SavedAgentSettings {
  const value = JSON.parse(text) as Partial<SavedAgentSettings>;
  if (value.schemaVersion !== 1 || typeof value.token !== 'string' || !value.token) throw new Error('Invalid Agent settings');
  return { schemaVersion: 1, token: value.token, port: validatePortSetting(value.port) };
}
function validatePortSetting(value: unknown): AgentPortSetting {
  if (!value || typeof value !== 'object') throw new CollectorError('invalid_request', '請選擇自動或指定連線埠。');
  const setting = value as { mode?: unknown; port?: unknown };
  if (setting.mode === 'auto' && Object.keys(setting).every((key) => key === 'mode')) return { mode: 'auto' };
  if (setting.mode === 'fixed' && Number.isInteger(setting.port) && Number(setting.port) >= 1 && Number(setting.port) <= 65535
    && Object.keys(setting).every((key) => key === 'mode' || key === 'port')) return { mode: 'fixed', port: Number(setting.port) };
  throw new CollectorError('invalid_request', '指定連線埠必須是 1 到 65535 的整數。');
}
function clonePort(value: AgentPortSetting): AgentPortSetting { return value.mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', port: value.port }; }
function samePort(a: AgentPortSetting, b: AgentPortSetting): boolean { return a.mode === b.mode && (a.mode === 'auto' || (b.mode === 'fixed' && a.port === b.port)); }
async function firstFreePort<T>(ports: number[], listen: (port: number) => Promise<T>): Promise<T> { for (const [index, port] of ports.entries()) { try { return await listen(port); } catch (error) { const taken = ['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''); if (!taken || index === ports.length - 1) throw error; } } throw new Error('No port to listen on'); }
function zipFiles(files: Array<{ name: string; data: Buffer }>): Promise<Buffer> { const zip = new yazl.ZipFile(); for (const file of files) zip.addBuffer(file.data, file.name); zip.end(); return new Promise((resolve, reject) => { const chunks: Buffer[] = []; const output = zip.outputStream as unknown as Readable; output.on('data', (chunk: Buffer) => chunks.push(chunk)); output.on('end', () => resolve(Buffer.concat(chunks))); output.on('error', reject); }); }
export type AgentAccess = AgentConnectionService;
