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
    const { Camoufox } = await import('camoufox-js');
    return {
      runtime,
      browserType,
      launch: async (launchOptions) => (await Camoufox(launchOptions)) as unknown as Browser,
      launchPersistentContext: async (userDataDir, launchOptions) =>
        (await Camoufox({
          ...launchOptions,
          user_data_dir: userDataDir,
        })) as unknown as BrowserContext,
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
