/**
 * The device log of XR Collector (record format in `src/shared/log/log-types.ts`).
 *
 * `write` stamps the record with the time from `now`, masks secrets and credentials in `message` and `stack`, prints it
 * to `output` (the process console unless another is given; `warn` and `error` records go to stderr) and appends it as
 * one JSON line to `<folder>/collector.jsonl`, all before returning except the file write, and never throws. When a
 * line would take the file past `maxFileBytes` (5 MiB unless given), the file is renamed to `collector.1.jsonl`,
 * replacing the one there, and a new file is started. File writes happen in the order of `write` calls; the first
 * failure of the run is reported to `output`, and later records keep going to `output` and are tried again in the file.
 *
 * `read` waits until the records written so far are in the file, then reads the current file and the previous one and
 * answers newest first. Lines that are not records are skipped, and a file that cannot be read counts as empty.
 * `flushed` resolves once every record written so far is in the file or has failed to be written.
 */
export type { CollectorLog, CollectorLogOptions, LogOutput } from './collector-log.js';

/** Opens the log writing into `folder`, normally `<profile>/logs`. The folder is created on the first file write. */
export { openCollectorLog } from './collector-log.js';
