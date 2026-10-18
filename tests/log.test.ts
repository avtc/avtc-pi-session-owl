// log: trace logs are ALWAYS on (nothing gates them; the dump limit
// governs dump files only).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGetSessionOwlSettings, _resetSessionOwlSettingsHandle } from "../src/config/schema.js";
import { _setBaseLoggerForTest, clearLogSessionScope, log, setLogSessionScope } from "../src/log.js";

// Swap in a spy sink so we observe calls without touching the real log file.
const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("log", () => {
  beforeEach(() => {
    sink.info.mockClear();
    sink.warn.mockClear();
    sink.error.mockClear();
    sink.debug.mockClear();
    clearLogSessionScope();
  });
  afterAll(() => {
    _setBaseLoggerForTest(null); // restore the real logger
    _resetGetSessionOwlSettings();
    _resetSessionOwlSettingsHandle();
  });

  it("always writes debug trace logs (nothing gates them)", () => {
    _setBaseLoggerForTest(sink);
    log.debug("trace");
    expect(sink.debug).toHaveBeenCalledTimes(1);
    expect(sink.debug).toHaveBeenCalledWith("trace");
  });

  it("always writes info/warn/error", () => {
    _setBaseLoggerForTest(sink);
    log.info("i");
    log.warn("w");
    log.error("e", new Error("boom"));
    expect(sink.info).toHaveBeenCalledWith("i");
    expect(sink.warn).toHaveBeenCalledWith("w");
    expect(sink.error).toHaveBeenCalledWith("e", expect.any(Error));
  });

  it("tags every line with the session scope ([s-<first 6 chars>]) once set", () => {
    _setBaseLoggerForTest(sink);
    setLogSessionScope("01a02596-de2e-707b-8016-1df74d3f13ce");
    log.info("hello");
    log.debug("dbg");
    expect(sink.info).toHaveBeenCalledWith("[s-01a025] hello");
    expect(sink.debug).toHaveBeenCalledWith("[s-01a025] dbg");
  });
});
