type Environment = Readonly<Record<string, string | undefined>>;

const PRODUCTION_APP_ID = 'com.moneydj.xrcollector';

/** The appId electron-builder packaged this App under: a validation package carries its own in package.json. */
export function appIdOf(packageMetadata: unknown): string {
  const appId = packageMetadata && typeof packageMetadata === 'object'
    ? (packageMetadata as Record<string, unknown>).xrCollectorAppId : undefined;
  return typeof appId === 'string' ? appId : PRODUCTION_APP_ID;
}

export function windowSize(env: Environment): { width: number; height: number } {
  const validationSize = /^(?<width>[0-9]+)x(?<height>[0-9]+)$/.exec(env.XR_COLLECTOR_VALIDATION_WINDOW_SIZE ?? '')?.groups;
  return validationSize ? { width: Number(validationSize.width), height: Number(validationSize.height) } : { width: 1240, height: 820 };
}
