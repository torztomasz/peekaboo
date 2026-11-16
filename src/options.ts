// The welcome and settings page. It has three entry points: the install tab (?welcome), the toolbar icon or
// Chrome's Options, and "Allow Auto" on a pull request (?from=<tab id>), which gets a page about that one
// step and is sent back to its pull request once Auto is on.
import { IMAGE_ORIGINS } from "./origins";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const fromTab = params.has("from") ? Number(params.get("from")) : null;

if (fromTab != null) {
  $("title").textContent = "Line up these screenshots";
  $("lede").textContent = "The Before and After on that pull request have different sizes. Turn on Auto-align and Peekaboo takes you back with them lined up.";
  $("auto").classList.add("focus");
} else if (!params.has("welcome")) {
  $("title").textContent = "Peekaboo";
  $("lede").textContent = "Flip and diff the Before and After screenshots in GitHub pull requests.";
}

async function render() {
  const on = await chrome.permissions.contains({ origins: IMAGE_ORIGINS });
  $("state").classList.toggle("is-on", on);
  $("stateText").textContent = on ? "On: different sizes line up by themselves" : "Off: line them up by hand with Left, Center or Right";
  $<HTMLButtonElement>("turnOn").hidden = on;
  $<HTMLButtonElement>("turnOff").hidden = !on;
  return on;
}

$("turnOn").addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins: IMAGE_ORIGINS });
  await render();
  if (!granted) {
    $("status").textContent = "Chrome didn't allow it. You can try again, or keep lining pairs up by hand.";
    return;
  }
  if (fromTab != null) {
    $("status").textContent = "On. Taking you back to the pull request…";
    try { await chrome.tabs.update(fromTab, { active: true }); } catch {}
    setTimeout(() => window.close(), 600);
  } else {
    $("status").textContent = "On. Pairs of different sizes now line up by themselves.";
  }
});

$("turnOff").addEventListener("click", async () => {
  await chrome.permissions.remove({ origins: IMAGE_ORIGINS });
  await render();
  $("status").textContent = "Off. Pairs of different sizes keep the Left, Center and Right buttons.";
});

render().then((on) => { if (fromTab != null && !on) $<HTMLButtonElement>("turnOn").focus(); });
