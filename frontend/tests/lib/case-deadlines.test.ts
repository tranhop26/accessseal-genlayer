import { describe, expect, it } from "vitest";
import {
  DEADLINE_PRESETS,
  DEFAULT_DEADLINE_PRESET_ID,
  getDeadlinePreset,
} from "@/lib/case-deadlines";

describe("case deadline presets", () => {
  it("keeps Standard as the immutable default", () => {
    expect(DEFAULT_DEADLINE_PRESET_ID).toBe("standard");
    expect(Object.isFrozen(DEADLINE_PRESETS)).toBe(true);
    for (const preset of Object.values(DEADLINE_PRESETS)) {
      expect(Object.isFrozen(preset)).toBe(true);
    }
    expect(getDeadlinePreset(DEFAULT_DEADLINE_PRESET_ID)).toMatchObject({
      evidenceDeadline: 86_400,
      hardDeadline: 604_800,
    });
  });

  it("defines the exact live-proof window", () => {
    expect(getDeadlinePreset("live-proof")).toMatchObject({
      evidenceDeadline: 14_400,
      hardDeadline: 43_200,
    });
    expect(DEADLINE_PRESETS).toHaveLength(2);
  });

  it("rejects an unknown runtime identifier", () => {
    expect(() => getDeadlinePreset("instant" as never)).toThrow(
      "Unsupported case deadline preset",
    );
  });
});
