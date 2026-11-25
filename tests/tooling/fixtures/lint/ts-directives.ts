// @ts-nocheck
export const a: number = 1;
// @ts-ignore
export const b: number = 'b';
/* @ts-expect-error */
export const c: number = 'c';
