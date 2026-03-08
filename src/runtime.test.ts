import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchrightLaunch: vi.fn(),
  patchrightLaunchPersistentContext: vi.fn(),
  patchrightFirefoxLaunch: vi.fn(),
  patchrightFirefoxLaunchPersistentContext: vi.fn(),
  patchrightWebkitLaunch: vi.fn(),
  patchrightWebkitLaunchPersistentContext: vi.fn(),
  playwrightFirefoxLaunch: vi.fn(),
  playwrightFirefoxLaunchPersistentContext: vi.fn(),
  camoufoxLaunchOptions: vi.fn(),
}));

vi.mock('patchright', () => ({
  chromium: {
    launch: mocks.patchrightLaunch,
    launchPersistentContext: mocks.patchrightLaunchPersistentContext,
  },
  firefox: {
    launch: mocks.patchrightFirefoxLaunch,
    launchPersistentContext: mocks.patchrightFirefoxLaunchPersistentContext,
  },
  webkit: {
    launch: mocks.patchrightWebkitLaunch,
    launchPersistentContext: mocks.patchrightWebkitLaunchPersistentContext,
  },
}));

vi.mock('playwright-core', () => ({
  firefox: {
    launch: mocks.playwrightFirefoxLaunch,
    launchPersistentContext: mocks.playwrightFirefoxLaunchPersistentContext,
  },
}));

vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn(),
  launchOptions: mocks.camoufoxLaunchOptions,
}));

import { getRuntimeLauncher } from './runtime.js';

describe('getRuntimeLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.camoufoxLaunchOptions.mockResolvedValue({
      executablePath: '/camoufox/firefox',
      env: { CAMOUFOX_ENV: '1' },
      firefoxUserPrefs: { 'privacy.resistFingerprinting': true },
      headless: false,
    });
    mocks.playwrightFirefoxLaunch.mockResolvedValue({ kind: 'browser' });
    mocks.playwrightFirefoxLaunchPersistentContext.mockResolvedValue({ kind: 'context' });
  });

  it('merges Camoufox launch options into non-empty browser launch options', async () => {
    const launcher = await getRuntimeLauncher({ runtime: 'camoufox' });

    await launcher.launch({
      headless: true,
      args: ['--agent-browser'],
      env: { APP_ENV: 'test' },
      proxy: { server: 'http://proxy.local:8080' },
    });

    expect(mocks.camoufoxLaunchOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        args: ['--agent-browser'],
        env: { APP_ENV: 'test' },
        proxy: { server: 'http://proxy.local:8080' },
      })
    );
    expect(mocks.playwrightFirefoxLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/camoufox/firefox',
        headless: true,
        args: ['--agent-browser'],
        env: {
          CAMOUFOX_ENV: '1',
          APP_ENV: 'test',
        },
        firefoxUserPrefs: {
          'privacy.resistFingerprinting': true,
        },
      })
    );
  });

  it('uses Camoufox executable for persistent contexts while keeping profile options', async () => {
    const launcher = await getRuntimeLauncher({ runtime: 'camoufox' });

    await launcher.launchPersistentContext('/tmp/camoufox-profile', {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userAgent: 'agent-browser-test',
    });

    expect(mocks.camoufoxLaunchOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
      })
    );
    expect(mocks.playwrightFirefoxLaunchPersistentContext).toHaveBeenCalledWith(
      '/tmp/camoufox-profile',
      expect.objectContaining({
        executablePath: '/camoufox/firefox',
        headless: true,
        viewport: { width: 1280, height: 720 },
        userAgent: 'agent-browser-test',
      })
    );
  });
});
