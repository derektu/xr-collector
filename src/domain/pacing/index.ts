/** The pacing module as other modules use it: the request channel of a pacing group. */
export {
  PacingGate,
  pacingOptionsFromEnv,
  pacingStateFile,
  type GatePriority,
  type Pacing,
  type PacingEvent,
} from './pacing-gate.js';
