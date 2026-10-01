import "./style.css";
import { App } from "./app";
import { initTheme, initThemeToggle } from "./theme";

initTheme();
new App();

const themeSwitch = document.getElementById("theme-switch-btn") as HTMLButtonElement | null;
if (themeSwitch) initThemeToggle(themeSwitch);
