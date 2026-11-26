import { readJsonFile, writeJsonFile } from '../../shared/lib/json-file.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export interface StillRunningHint {
  title: string;
  content: string;
}

export interface CloseHintOptions {
  platform: NodeJS.Platform;
  record: Pick<CloseHintRecord, 'shown' | 'markShown'>;
  notify: (hint: StillRunningHint) => void;
  log: LogWriter;
}

const STILL_RUNNING_HINT: StillRunningHint = {
  title: 'XR Collector 仍在系統匣執行',
  content: '收集會繼續。要結束，在系統匣圖示按右鍵選「結束」。',
};

function recordsHintShown(value: unknown): value is { closeHintShown: true } {
  return typeof value === 'object' && value !== null && 'closeHintShown' in value && value.closeHintShown === true;
}

export class CloseHintRecord {
  constructor(private readonly file: string, private readonly log: LogWriter) {}

  async shown(): Promise<boolean> {
    try {
      return recordsHintShown(await readJsonFile(this.file));
    } catch (error: unknown) {
      this.log.write({ level: 'warn', source: 'desktop', message: 'Unable to read the close hint record', error });
      return false;
    }
  }

  async markShown(): Promise<void> {
    await writeJsonFile(this.file, { closeHintShown: true });
  }
}

export async function hintStillRunning({ platform, record, notify, log }: CloseHintOptions): Promise<void> {
  if (platform !== 'win32' || await record.shown()) return;
  notify(STILL_RUNNING_HINT);
  await record.markShown().catch((error: unknown) => log.write({ level: 'warn', source: 'desktop', message: 'Unable to save the close hint record', error }));
}
