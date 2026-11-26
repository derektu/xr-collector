const minutes = (count) => count * 60_000;

/** The `npm run verify` steps (npm script names) in the order they run, each with its limit in milliseconds. */
export const VERIFY_STEPS = [
  { step: 'lint', limit: minutes(3) },
  { step: 'test', limit: minutes(10) },
  { step: 'typecheck:tests', limit: minutes(3) },
  { step: 'build', limit: minutes(5) },
];

/** The limit of one `verify.mjs flows run` of the verify skill, all its flows together, in milliseconds. */
export const FLOWS_RUN_LIMIT = minutes(30);
