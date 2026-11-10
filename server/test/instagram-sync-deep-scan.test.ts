import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The intensive-scan request.
 *
 * The request exists so that a run which did not go well is followed by one
 * that looks further down the list. It must not become a permanent state:
 * a poll that always runs intensively is slower than the fault it was meant
 * to cure.
 */

const settings = new Map<string, string>();

vi.mock("../dist/db/repositories.js", () => ({
  appSettingsRepository: {
    get: vi.fn(async (key: string) => settings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    })
  }
}));

describe('the intensive-scan request', () => {
  beforeEach(() => {
    settings.clear();
  });

  it('is asked for when a run goes wrong', async () => {
    const { readDeepScanState, settleDeepScan } = await import(
      "../../plugins/instagram-sync/src/state.js"
    );

    expect((await readDeepScanState()).collections).toBe(false);

    await settleDeepScan("collections", true, "the mirror failed");

    const state = await readDeepScanState();
    expect(state.collections).toBe(true);
    expect(state.reason).toBe("the mirror failed");
  });

  it('is consumed by the run that uses it', async () => {
    const { readDeepScanState, settleDeepScan } = await import(
      "../../plugins/instagram-sync/src/state.js"
    );

    await settleDeepScan("collections", true, "the mirror failed");
    expect((await readDeepScanState()).collections).toBe(true);

    // The run that went intensively consumes the request.
    await settleDeepScan("collections", false, "all good");
    expect((await readDeepScanState()).collections).toBe(false);
  });

  it('is not asked for again while the same fault lasts', async () => {
    const { readDeepScanState, settleDeepScan } = await import(
      "../../plugins/instagram-sync/src/state.js"
    );

    // The first fault asks for a scan.
    await settleDeepScan("collections", true, "the mirror failed");
    expect((await readDeepScanState()).collections).toBe(true);

    // The intensive run fails the same way. The scan has had its turn, so
    // the next poll is a normal one — otherwise every poll would be
    // intensive, which is slower than the fault.
    await settleDeepScan("collections", true, "the mirror failed again");
    expect((await readDeepScanState()).collections).toBe(false);

    // And a clean run ends the episode: the next fault asks again.
    await settleDeepScan("collections", false, "all good");
    await settleDeepScan("collections", true, "the mirror failed");
    expect((await readDeepScanState()).collections).toBe(true);
  });

  it('keeps the two scopes apart', async () => {
    const { readDeepScanState, settleDeepScan } = await import(
      "../../plugins/instagram-sync/src/state.js"
    );

    await settleDeepScan("library", true, "the sync failed");
    const state = await readDeepScanState();

    expect(state.library).toBe(true);
    expect(state.collections).toBe(false);
  });
});
