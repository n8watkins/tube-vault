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

  it('reports enqueue storage failures without acknowledging or running the job', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    const nativeCalls: Record<string, unknown>[] = [];
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        nativeCalls.push(payload);
        callback({ ok: true });
      }),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            callback(Array.isArray(defaults) ? {} : { ...defaults, tvJobs: [] });
          }),
          set: vi.fn((_values: Record<string, unknown>, callback: () => void) => {
            runtime.lastError = { message: 'Storage quota exceeded' };
            callback();
            runtime.lastError = undefined;
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    const response = await new Promise<unknown>((resolve) => {
      messageListener?.({
        type: 'TUBE_VAULT_ENQUEUE',
        items: [{ url: 'https://youtube.test/one', bytes: 1 }],
      }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'Storage quota exceeded' });
    expect(nativeCalls).toEqual([]);
  });

  it('does not request a summary when persisting its attempt fails', async () => {
    const jobs = [{
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
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        nativeCalls.push(payload);
        callback({ ok: true });
      }),
      onMessage: { addListener: vi.fn() },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (Array.isArray(defaults)) callback({});
            else if ('collectHistory' in defaults) callback(defaults);
            else callback({ tvJobs: structuredClone(jobs) });
          }),
          set: vi.fn((values: Record<string, unknown>, callback: () => void) => {
            if ('tvBatchSummaryAttempts' in values) runtime.lastError = { message: 'Storage quota exceeded' };
            callback();
            runtime.lastError = undefined;
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    await vi.waitFor(() => expect(chromeStub.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ tvBatchSummaryAttempts: { batch: 1 } }),
      expect.any(Function),
    ));

    expect(nativeCalls).toEqual([]);
  });

  it('reports settings read failures to ping callers', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    const runtime = {
      sendNativeMessage: vi.fn(),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((_defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            runtime.lastError = { message: 'Settings unavailable' };
            callback({});
            runtime.lastError = undefined;
          }),
          set: vi.fn(),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    const response = await new Promise<unknown>((resolve) => {
      messageListener?.({ type: 'TUBE_VAULT_PING' }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'Settings unavailable' });
    expect(runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  it('reports output-root storage failures to ping callers', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, _payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        callback({ ok: true, defaultRoot: 'C:\\TubeVault' });
      }),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            callback(Array.isArray(defaults) ? {} : defaults);
          }),
          set: vi.fn((_values: Record<string, unknown>, callback: () => void) => {
            runtime.lastError = { message: 'Output root unavailable' };
            callback();
            runtime.lastError = undefined;
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    const response = await new Promise<unknown>((resolve) => {
      messageListener?.({ type: 'TUBE_VAULT_PING' }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'Output root unavailable' });
  });

  it('reports coordinator storage read failures to native request callers', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    let readCount = 0;
    const runtime = {
      sendNativeMessage: vi.fn(),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            readCount += 1;
            if (readCount === 1) {
              callback(defaults as Record<string, unknown>);
              return;
            }
            runtime.lastError = { message: 'Jobs unavailable' };
            callback({});
            runtime.lastError = undefined;
          }),
          set: vi.fn(),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    const response = await new Promise<unknown>((resolve) => {
      messageListener?.({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'diagnostics' } }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'Jobs unavailable' });
    expect(runtime.sendNativeMessage).not.toHaveBeenCalled();
  });
});
