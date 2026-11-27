/**
 * Resolves after `ms`, standing in for the time a real service takes to answer. Only the synthetic
 * services in `server.mts` use it; a wait for a state goes through `waitFor` in `wait.mjs`.
 */
export const simulateLatency = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
