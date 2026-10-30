import { describe, expect, it } from 'vitest';
import { appIdFromPackageMetadata, PRODUCTION_APP_ID, PRODUCTION_UPDATE_REPOSITORY, updateRepositoryFromPackageMetadata } from '../../src/updates/config.js';

describe('packaged update repository', () => {
  it('keeps ordinary packages on the production repository', () => {
    expect(updateRepositoryFromPackageMetadata({ name: 'xr-collector' })).toBe(PRODUCTION_UPDATE_REPOSITORY);
  });

  it('uses a strictly validated repository baked into validation package metadata', () => {
    expect(updateRepositoryFromPackageMetadata({ xrCollectorUpdateRepository: 'derektu/xr-collector-test' })).toBe('derektu/xr-collector-test');
    expect(() => updateRepositoryFromPackageMetadata({ xrCollectorUpdateRepository: 'https://github.com/derektu/xr-collector-test' })).toThrow(/owner\/name/u);
  });

  it('keeps production AUMID unless a validation id is baked into the package', () => {
    expect(appIdFromPackageMetadata({ name: 'xr-collector' })).toBe(PRODUCTION_APP_ID);
    expect(appIdFromPackageMetadata({ xrCollectorAppId: 'com.xrcollector.verify.public' })).toBe('com.xrcollector.verify.public');
    expect(() => appIdFromPackageMetadata({ xrCollectorAppId: 'com.moneydj.xrcollector.other' })).toThrow(/app id/u);
  });
});
