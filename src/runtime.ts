import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'patchright';
import type { LaunchCommand } from './types.js';

export type BrowserRuntime = 'patchright' | 'camoufox';
export type BrowserTypeName = 'chromium' | 'firefox' | 'webkit';

export interface RuntimeCompatibilityOptions {
  runtime: BrowserRuntime;
  browserType: BrowserTypeName;
  hasExtensions: boolean;
  allowFileAccess: boolean;
}

export interface RuntimeLauncher {
  runtime: BrowserRuntime;
  browserType: BrowserTypeName;
  launch: (options: Record<string, unknown>) => Promise<Browser>;
  launchPersistentContext: (
    userDataDir: string,
    options: Record<string, unknown>
  ) => Promise<BrowserContext>;
}

function mergeCamoufoxLaunchOptions(
  camoufoxOptions: Record<string, unknown>,
  playwrightOptions: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...camoufoxOptions,
    ...playwrightOptions,
  };

  const camoufoxEnv = camoufoxOptions.env as Record<string, string> | undefined;
  const playwrightEnv = playwrightOptions.env as Record<string, string> | undefined;
  if (camoufoxEnv || playwrightEnv) {
    merged.env = {
      ...(camoufoxEnv ?? {}),
      ...(playwrightEnv ?? {}),
    };
  }

  const camoufoxFirefoxPrefs = camoufoxOptions.firefoxUserPrefs as
    | Record<string, unknown>
    | undefined;
  const playwrightFirefoxPrefs = playwrightOptions.firefoxUserPrefs as
    | Record<string, unknown>
    | undefined;
  if (camoufoxFirefoxPrefs || playwrightFirefoxPrefs) {
    merged.firefoxUserPrefs = {
      ...(camoufoxFirefoxPrefs ?? {}),
      ...(playwrightFirefoxPrefs ?? {}),
    };
  }

  return merged;
}

export function resolveRuntime(runtime?: string): BrowserRuntime {
  return runtime === 'camoufox' ? 'camoufox' : 'patchright';
}

export function getBrowserTypeForRuntime(
  runtime: BrowserRuntime,
  browserType?: LaunchCommand['browser']
): BrowserTypeName {
  if (runtime === 'camoufox') {
    return 'firefox';
  }
  return browserType ?? 'chromium';
}

export function validateRuntimeCompatibility(options: RuntimeCompatibilityOptions): void {
  const { runtime, browserType, hasExtensions, allowFileAccess } = options;

  if (runtime === 'camoufox' && browserType !== 'firefox') {
    throw new Error('Camoufox runtime only supports Firefox');
  }

  if (runtime === 'camoufox' && (hasExtensions || allowFileAccess)) {
    throw new Error('Camoufox runtime does not support Chromium-only features');
  }
}

export async function getRuntimeLauncher(
  options: Pick<LaunchCommand, 'runtime' | 'browser' | 'extensions' | 'allowFileAccess'>
): Promise<RuntimeLauncher> {
  // Runtime is intentionally resolved here so CLI, daemon env, and bridge sessions
  // all share the same compatibility rules and launcher selection.
  const runtime = resolveRuntime(options.runtime ?? process.env.AGENT_BROWSER_RUNTIME);
  const browserType = getBrowserTypeForRuntime(runtime, options.browser);
  const hasExtensions = !!options.extensions?.length;
  const allowFileAccess = options.allowFileAccess ?? false;

  validateRuntimeCompatibility({
    runtime,
    browserType,
    hasExtensions,
    allowFileAccess,
  });

  if (runtime === 'camoufox') {
    const [{ firefox: playwrightFirefox }, { launchOptions: getCamoufoxLaunchOptions }] =
      await Promise.all([import('playwright-core'), import('camoufox-js')]);

    const buildCamoufoxOptions = async (launchOptions: Record<string, unknown>) => {
      const executablePath =
        typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath : undefined;
      const camoufoxOptions = await getCamoufoxLaunchOptions({
        headless: launchOptions.headless as boolean | undefined,
        args: launchOptions.args as string[] | undefined,
        env: launchOptions.env as Record<string, string> | undefined,
        proxy: launchOptions.proxy as Record<string, unknown> | undefined,
        executable_path: executablePath,
      });
      return mergeCamoufoxLaunchOptions(camoufoxOptions as Record<string, unknown>, launchOptions);
    };

    return {
      runtime,
      browserType,
      launch: async (launchOptions) =>
        (await playwrightFirefox.launch(
          (await buildCamoufoxOptions(launchOptions)) as any
        )) as unknown as Browser,
      launchPersistentContext: async (userDataDir, launchOptions) =>
        (await playwrightFirefox.launchPersistentContext(
          userDataDir,
          (await buildCamoufoxOptions(launchOptions)) as any
        )) as unknown as BrowserContext,
    };
  }

  const launcher =
    browserType === 'firefox' ? firefox : browserType === 'webkit' ? webkit : chromium;
  return {
    runtime,
    browserType,
    launch: async (launchOptions) => launcher.launch(launchOptions as any),
    launchPersistentContext: async (userDataDir, launchOptions) =>
      launcher.launchPersistentContext(userDataDir, launchOptions as any),
  };
}
