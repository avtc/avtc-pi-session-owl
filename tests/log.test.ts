// log: `debug` honors the live `debugLog` setting (read each call so toggling it
// in /mk:settings takes effect immediately). info/warn/error always write.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGetMemkeeperSettings,
  _resetMemkeeperSettingsHandle,
  _setGetMemkeeperSettings,
  type MemkeeperConfig,
} from "../src/config/schema.js";
import { _setBaseLoggerForTest, log } from "../src/log.js";

// Swap in a spy sink so we observe calls without touching the real log file.
const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function settingsWith(debugLog: boolean): void {
  _setGetMemkeeperSettings(() => ({ debugLog }) as unknown as MemkeeperConfig);
}

describe("log", () => {
  beforeEach(() => {
    sink.info.mockClear();
    sink.warn.mockClear();
    sink.error.mockClear();
    sink.debug.mockClear();
  });
  afterAll(() => {
    _setBaseLoggerForTest(null); // restore the real logger
    _resetGetMemkeeperSettings();
    _resetMemkeeperSettingsHandle();
  });

  it("writes a debug message only when debugLog is on", () => {
    _setBaseLoggerForTest(sink);
    settingsWith(false);
    log.debug("off");
    expect(sink.debug).not.toHaveBeenCalled();

    settingsWith(true);
    log.debug("on");
    expect(sink.debug).toHaveBeenCalledTimes(1);
    expect(sink.debug).toHaveBeenCalledWith("on");
  });

  it("reads debugLog live each call (a mid-session toggle takes effect immediately)", () => {
    _setBaseLoggerForTest(sink);
    settingsWith(false);
    log.debug("a"); // suppressed
    settingsWith(true);
    log.debug("b"); // written
    settingsWith(false);
    log.debug("c"); // suppressed again
    expect(sink.debug).toHaveBeenCalledTimes(1);
    expect(sink.debug).toHaveBeenCalledWith("b");
  });

  it("always writes info/warn/error regardless of debugLog", () => {
    _setBaseLoggerForTest(sink);
    settingsWith(false);
    log.info("i");
    log.warn("w");
    log.error("e", new Error("boom"));
    expect(sink.info).toHaveBeenCalledWith("i");
    expect(sink.warn).toHaveBeenCalledWith("w");
    expect(sink.error).toHaveBeenCalledWith("e", expect.any(Error));
  });
});
