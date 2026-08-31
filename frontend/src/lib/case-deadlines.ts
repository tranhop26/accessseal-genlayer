export type DeadlinePresetId = "standard" | "live-proof";

export type DeadlinePreset = Readonly<{
  id: DeadlinePresetId;
  label: string;
  description: string;
  evidenceDeadline: number;
  hardDeadline: number;
  warning?: string;
}>;

export const DEFAULT_DEADLINE_PRESET_ID: DeadlinePresetId = "standard";

export const DEADLINE_PRESETS: readonly DeadlinePreset[] = Object.freeze([
  Object.freeze({
    id: "standard",
    label: "Standard — 24 hours / 7 days",
    description: "Default testnet review window for normal case handling.",
    evidenceDeadline: 86_400,
    hardDeadline: 604_800,
  }),
  Object.freeze({
    id: "live-proof",
    label: "Live proof — 4 hours / 12 hours",
    description: "Short Bradbury proof window for a supervised live run.",
    warning:
      "Short testnet window: delayed consensus can prevent completion before the hard deadline.",
    evidenceDeadline: 14_400,
    hardDeadline: 43_200,
  }),
]);

export function getDeadlinePreset(id: DeadlinePresetId): DeadlinePreset {
  const preset = DEADLINE_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error("Unsupported case deadline preset");
  return preset;
}
