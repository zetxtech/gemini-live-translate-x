import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings, type SubtitleSettings } from "./subtitle-settings-shared";

function baseSettings(overrides: Partial<SubtitleSettings> = {}): SubtitleSettings {
  return { ...defaultSettings(), ...overrides };
}

describe("normalizeSettings bgOpacity", () => {
  it("keeps 0 (fully opaque) instead of falling back to the default", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: 0 }));
    expect(normalized.bgOpacity).toBe(0);
  });

  it("keeps 1 (fully transparent)", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: 1 }));
    expect(normalized.bgOpacity).toBe(1);
  });

  it("keeps a normal mid value", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: 0.4 }));
    expect(normalized.bgOpacity).toBe(0.4);
  });

  it("clamps negative values to 0", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: -0.3 }));
    expect(normalized.bgOpacity).toBe(0);
  });

  it("clamps values above 1 to 1", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: 1.4 }));
    expect(normalized.bgOpacity).toBe(1);
  });

  it("falls back to the default for non-numeric values", () => {
    const normalized = normalizeSettings(baseSettings({ bgOpacity: Number.NaN }));
    expect(normalized.bgOpacity).toBe(0.5);
  });
});
