import { afterEach, describe, expect, it, vi } from 'vitest';

describe('service worker startup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('hydrates privacy settings before recovering and finalizing jobs', async () => {
    let settingsCallback: ((values: Record<string, unknown>) => void) | undefined;
    let jobs = [{
      id: 'one',
      batchId: 'batch',
      videoUrl: 'https://youtube.test/one',
      label: 'One',
      components: {},
      status: 'done',
      createdAt: 1,
      finishedAt: 2,
    }];
    const nativeCalls: Record<string, unknown>[] = [];
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (!Array.isArray(defaults) && 'collectHistory' in defaults) {
              settingsCallback = callback;
              return;
            }
            if (Array.isArray(defaults)) {
              callback({});
              return;
            }
            callback({ tvJobs: structuredClone(jobs) });
          }),
          set: vi.fn((values: Record<string, unknown>, callback: () => void) => {
            if (Array.isArray(values.tvJobs)) jobs = structuredClone(values.tvJobs);
            callback();
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime: {
        sendNativeMessage: vi.fn((_host: string, payload: Record<string, unknown>, callback: (response: unknown) => void) => {
          nativeCalls.push(payload);
          callback({ ok: true });
        }),
        onMessage: { addListener: vi.fn() },
        lastError: undefined,
      },
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    await Promise.resolve();
    expect(nativeCalls).toEqual([]);

    settingsCallback?.({ collectHistory: false });

    await vi.waitFor(() => expect(nativeCalls).toEqual([
      expect.objectContaining({ action: 'batch_summary', batchId: 'batch' }),
    ]));
    await vi.waitFor(() => expect(jobs).toEqual([]));
  });
});
