export type Align = "left" | "center" | "right";
export type Palette = "red" | "yellow" | "green" | "blue" | "purple" | "gray";
export type BgStyle = "none" | "glass" | "black" | "white";

const BG_STYLES: BgStyle[] = ["none", "glass", "black", "white"];

const PALETTES: Palette[] = ["red", "yellow", "green", "blue", "purple", "gray"];

export type SubtitleSettings = {
  alwaysOnTop: boolean;
  bilingual: boolean;
  historyRows: 0 | 1 | 2;
  palette: Palette;
  customColor: string;
  align: Align;
  bgStyle: BgStyle;
  // Transparency of the subtitle background: 0 = fully opaque, 1 = fully transparent.
  bgOpacity: number;
};

export const SETTINGS_KEY = "mt-subtitle-settings";

export function defaultSettings(): SubtitleSettings {
  return {
    alwaysOnTop: true,
    bilingual: true,
    historyRows: 1,
    palette: "red",
    customColor: "#ff6b9d",
    align: "left",
    bgStyle: "glass",
    bgOpacity: 0.5,
  };
}

export function loadSettings(): SubtitleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return normalizeSettings({ ...defaultSettings(), ...JSON.parse(raw) });
  } catch {}
  return defaultSettings();
}

export function saveSettings(settings: SubtitleSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

export function normalizeSettings(settings: SubtitleSettings): SubtitleSettings {
  const palette = PALETTES.includes(settings.palette) ? settings.palette : "red";
  const bgStyle = BG_STYLES.includes(settings.bgStyle) ? settings.bgStyle : "glass";
  const parsedOpacity = Number(settings.bgOpacity);
  // Fall back to the default only for non-numeric values; 0 is a valid transparency.
  const bgOpacity = Number.isFinite(parsedOpacity)
    ? Math.min(1, Math.max(0, parsedOpacity))
    : 0.5;
  return {
    ...settings,
    palette,
    bgStyle,
    align: "left",
    bgOpacity,
    historyRows: settings.bilingual && settings.historyRows > 1 ? 1 : settings.historyRows,
  };
}

export function alignLabel(align: Align) {
  return align === "left" ? "左" : align === "right" ? "右" : "中";
}

export function bgLabel(style: BgStyle) {
  return style === "none" ? "无" : style === "glass" ? "玻璃" : style === "black" ? "黑色" : "白色";
}

export function mixColor(a: string, b: string, amount: number) {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const channel = (x: number, y: number) => Math.round(x + (y - x) * amount).toString(16).padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

export function hexToRgba(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function applyTextVariables(target: HTMLElement, _settings: SubtitleSettings) {
  target.style.removeProperty("--text-top");
  target.style.removeProperty("--text-mid");
  target.style.removeProperty("--text-bottom");
  target.style.removeProperty("--text-solid");
  target.style.removeProperty("--text-stroke");
}
