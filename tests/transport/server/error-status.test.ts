// Broken, the UI and Agents act on the wrong HTTP status for an error.
import { describe, expect, it } from 'vitest';
import { errorStatus } from '../../../src/transport/server/error-status.js';
import { fakeDefinition } from '../../support/fake-source-plugin.js';
import { PRODUCT_SOURCES, productSourcesWith } from '../../support/product-sources.js';

describe('the HTTP status of an error code', () => {
  it('takes a code from the source type that declares it, keeps the core\'s own codes, and answers 500 otherwise', () => {
    const coreStatus = errorStatus(PRODUCT_SOURCES, 'rate_limited');
    const declaring = { ...fakeDefinition('status-test', 'status-test-net'), errorStatus: { status_test_gone: 410, rate_limited: 418 } };
    expect(errorStatus(PRODUCT_SOURCES, 'status_test_gone')).toBe(500);
    const sources = productSourcesWith(declaring);
    expect(errorStatus(sources, 'status_test_gone')).toBe(410);
    expect(errorStatus(sources, 'rate_limited')).toBe(coreStatus);
    expect(errorStatus(sources, 'nobody_declares_this')).toBe(500);
  });
});
