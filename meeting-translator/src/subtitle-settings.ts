import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  bgLabel,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type BgStyle,
  type Palette,
  type SubtitleSettings,
} from "./subtitle-settings-shared";

const setTop = document.getElementById("set-top") as HTMLButtonElement;
const setBilingual = document.getElementById("set-bilingual") as HTMLButtonElement;
const historyValue = document.getElementById("history-value")!;
const bgValue = document.getElementById("bg-value")!;
const setBgOpacity = document.getElementById("set-bg-opacity") as HTMLInputElement;
const opacityRow = document.getElementById("opacity-row")!;

let settings = loadSettings();

function clearSubmenus() {
  document.querySelectorAll<HTMLElement>(".has-sub.open").forEach((item) => item.classList.remove("open"));
}

function closeMenu() {
  clearSubmenus();
  invoke("hide_subtitle_settings").catch(console.error);
}

function publish() {
  settings = normalizeSettings(settings);
  saveSettings(settings);
  applyMenu();
  emit("subtitle-settings-changed", settings);
}

function applyMenu() {
  setTop.classList.toggle("checked", settings.alwaysOnTop);
  setBilingual.classList.toggle("checked", settings.bilingual);
  historyValue.textContent = `${settings.historyRows}`;
  bgValue.textContent = bgLabel(settings.bgStyle);
  setBgOpacity.value = String(settings.bgOpacity);
  opacityRow.classList.toggle("hidden", settings.bgStyle === "glass" || settings.bgStyle === "none");

  document.querySelectorAll<HTMLButtonElement>("[data-palette]").forEach((button) => {
    button.classList.toggle("active", button.dataset.palette === settings.palette);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((button) => {
    const value = Number(button.dataset.history);
    button.classList.toggle("active", value === settings.historyRows);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-bg-style]").forEach((button) => {
    button.classList.toggle("active", button.dataset.bgStyle === settings.bgStyle);
  });
}

setTop.addEventListener("click", async () => {
  settings.alwaysOnTop = !settings.alwaysOnTop;
  publish();
  closeMenu();
  try { await invoke("set_subtitle_always_on_top", { alwaysOnTop: settings.alwaysOnTop }); } catch (err) { console.error(err); }
});

setBilingual.addEventListener("click", () => { settings.bilingual = !settings.bilingual; publish(); closeMenu(); });
setBgOpacity.addEventListener("input", () => { settings.bgOpacity = Number(setBgOpacity.value); publish(); });
setBgOpacity.addEventListener("change", closeMenu);

document.querySelectorAll<HTMLElement>(".has-sub").forEach((item) => {
  item.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  item.addEventListener("pointerenter", () => {
    document.querySelectorAll<HTMLElement>(".has-sub.open").forEach((openItem) => {
      if (openItem !== item) openItem.classList.remove("open");
    });
    item.classList.add("open");
  });
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll<HTMLElement>(".has-sub.open").forEach((openItem) => {
      if (openItem !== item) openItem.classList.remove("open");
    });
    item.classList.add("open");
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    settings.historyRows = Number(button.dataset.history) as 0 | 1 | 2;
    // Two history rows cannot show original English text next to the current
    // translation, so choosing it turns bilingual mode off.
    if (settings.historyRows > 1) settings.bilingual = false;
    publish();
    closeMenu();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-palette]").forEach((button) => {
  button.addEventListener("click", (event) => { event.stopPropagation(); settings.palette = button.dataset.palette as Palette; publish(); closeMenu(); });
});

document.querySelectorAll<HTMLButtonElement>("[data-bg-style]").forEach((button) => {
  button.addEventListener("click", (event) => { event.stopPropagation(); settings.bgStyle = button.dataset.bgStyle as BgStyle; publish(); closeMenu(); });
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".settings-menu")) closeMenu();
});

listen<SubtitleSettings>("subtitle-settings-open", (event) => {
  clearSubmenus();
  settings = normalizeSettings(event.payload);
  applyMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

window.addEventListener("blur", () => {
  closeMenu();
});

applyMenu();
