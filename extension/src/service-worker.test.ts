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
              callback({ tvBatchSummarySchemaVersion: 1 });
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
      { action: 'batch_summary_finalize', batchId: 'batch' },
    ]));
    await vi.waitFor(() => expect(jobs).toEqual([]));
  });

  it('waits for coordinator readiness before handling a queue alarm', async () => {
    let settingsCallback: ((values: Record<string, unknown>) => void) | undefined;
    let alarmListener: ((alarm: { name: string }) => void) | undefined;
    const nativeCalls: Record<string, unknown>[] = [];
    let jobs = [{
      id: 'queued',
      videoUrl: 'https://youtube.test/queued',
      label: 'Queued',
      components: {},
      status: 'queued',
      createdAt: 1,
    }];
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (!Array.isArray(defaults) && 'collectHistory' in defaults) {
              settingsCallback = callback;
              return;
            }
            callback(Array.isArray(defaults) ? {} : { tvJobs: structuredClone(jobs) });
          }),
          set: vi.fn((values: Record<string, unknown>, callback: () => void) => {
            if (Array.isArray(values.tvJobs)) jobs = structuredClone(values.tvJobs) as typeof jobs;
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
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn((listener) => { alarmListener = listener; }) },
      },
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    alarmListener?.({ name: 'tube-vault-queue-wake' });
    await Promise.resolve();
    expect(nativeCalls).toEqual([]);

    settingsCallback?.({ outputRoot: '/configured/root' });
    await vi.waitFor(() => expect(nativeCalls).toContainEqual(expect.objectContaining({
      action: 'custom',
      options: expect.objectContaining({ outputRoot: '/configured/root' }),
    })));
    expect(nativeCalls.filter((call) => call.action === 'custom')).toHaveLength(1);
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
      expect.objectContaining({
        tvBatchSummaryAttempts: {
          batch: { attempts: 1, outputRoot: '' },
        },
      }),
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

  it('retries coordinator initialization after a transient settings failure', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    let settingsReads = 0;
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, _payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        callback({ ok: true, version: '0.3.81', defaultRoot: '' });
      }),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (!Array.isArray(defaults) && 'collectHistory' in defaults) {
              settingsReads += 1;
              if (settingsReads === 1) runtime.lastError = { message: 'Settings unavailable' };
              callback(defaults);
              runtime.lastError = undefined;
              return;
            }
            callback(Array.isArray(defaults) ? {} : { tvJobs: [] });
          }),
          set: vi.fn((_values: Record<string, unknown>, callback: () => void) => callback()),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    await vi.waitFor(() => expect(settingsReads).toBe(1));
    const response = await new Promise<unknown>((resolve) => {
      messageListener?.({ type: 'TUBE_VAULT_PING' }, {}, resolve);
    });

    expect(response).toEqual({ ok: true, version: '0.3.81', platform: undefined, defaultRoot: '' });
    expect(settingsReads).toBe(2);
    expect(runtime.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  it('uses a durable alarm to retry cold-start initialization without user activity', async () => {
    let alarmListener: ((alarm: { name: string }) => void) | undefined;
    let settingsReads = 0;
    let storageAvailable = false;
    const nativeCalls: Record<string, unknown>[] = [];
    let jobs = [{
      id: 'queued',
      videoUrl: 'https://youtube.test/queued',
      label: 'Queued',
      components: {},
      status: 'queued',
      createdAt: 1,
    }];
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        nativeCalls.push(payload);
        callback({ ok: true });
      }),
      onMessage: { addListener: vi.fn() },
      lastError: undefined as { message?: string } | undefined,
    };
    const alarms = {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn((listener) => { alarmListener = listener; }) },
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (!Array.isArray(defaults) && 'collectHistory' in defaults) {
              settingsReads += 1;
              if (!storageAvailable) runtime.lastError = { message: 'Storage unavailable' };
              callback(defaults);
              runtime.lastError = undefined;
              return;
            }
            callback(Array.isArray(defaults) ? {} : { tvJobs: structuredClone(jobs) });
          }),
          set: vi.fn((values: Record<string, unknown>, callback: () => void) => {
            if (Array.isArray(values.tvJobs)) jobs = structuredClone(values.tvJobs) as typeof jobs;
            callback();
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      alarms,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    await vi.waitFor(() => expect(alarms.create).toHaveBeenCalledWith(
      'tube-vault-queue-wake',
      expect.objectContaining({ when: expect.any(Number) }),
    ));
    expect(settingsReads).toBe(1);
    expect(nativeCalls).toEqual([]);

    storageAvailable = true;
    alarmListener?.({ name: 'tube-vault-queue-wake' });

    await vi.waitFor(() => expect(nativeCalls).toContainEqual(expect.objectContaining({ action: 'custom' })));
    expect(settingsReads).toBe(2);
    expect(nativeCalls.filter((call) => call.action === 'custom')).toHaveLength(1);
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

  it('uses one alarm to resume queued work after prolonged storage failure', async () => {
    let messageListener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    let alarmListener: ((alarm: { name: string }) => void) | undefined;
    let jobs: Record<string, unknown>[] = [];
    let storageAvailable = true;
    const nativeCalls: Record<string, unknown>[] = [];
    const runtime = {
      sendNativeMessage: vi.fn((_host: string, payload: Record<string, unknown>, callback: (response: unknown) => void) => {
        nativeCalls.push(payload);
        callback({ ok: true, folderPath: '/videos/item' });
      }),
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      lastError: undefined as { message?: string } | undefined,
    };
    const alarms = {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn((listener) => { alarmListener = listener; }) },
    };
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn((defaults: Record<string, unknown> | string[], callback: (values: Record<string, unknown>) => void) => {
            if (!Array.isArray(defaults) && 'collectHistory' in defaults) {
              callback(defaults);
              return;
            }
            if (!storageAvailable) {
              runtime.lastError = { message: 'Storage unavailable' };
              callback({});
              runtime.lastError = undefined;
              return;
            }
            callback(Array.isArray(defaults) ? {} : { tvJobs: structuredClone(jobs) });
          }),
          set: vi.fn((values: Record<string, unknown>, callback: () => void) => {
            if (Array.isArray(values.tvJobs)) jobs = structuredClone(values.tvJobs) as Record<string, unknown>[];
            callback();
            if (jobs.some((job) => job.status === 'queued')) storageAvailable = false;
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      runtime,
      alarms,
      notifications: { create: vi.fn() },
    };
    vi.stubGlobal('chrome', chromeStub);

    await import('./service-worker');
    await vi.waitFor(() => expect(messageListener).toBeDefined());
    await new Promise<void>((resolve) => {
      messageListener?.({
        type: 'TUBE_VAULT_ENQUEUE',
        items: [{ url: 'https://youtube.test/queued', bytes: 1 }],
      }, {}, () => resolve());
    });
    await vi.waitFor(() => expect(alarms.create).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(alarms.create).toHaveBeenCalledWith('tube-vault-queue-wake', expect.objectContaining({ when: expect.any(Number) }));

    storageAvailable = true;
    alarmListener?.({ name: 'tube-vault-queue-wake' });
    await vi.waitFor(() => expect(nativeCalls).toContainEqual(expect.objectContaining({ action: 'custom' })));
    expect(nativeCalls.filter((call) => call.action === 'custom')).toHaveLength(1);
  });
});
