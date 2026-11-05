/**
 * The words a `job.completed` event's message opens with when a collection finished: an item stored
 * new, or a check that was not skipped ("收集完成。", "收集完成：新增 2 支影片。"). The job manager
 * writes them; the Activity page recognizes them to say the line in its own words.
 */
export const COLLECTION_COMPLETED = '收集完成';
