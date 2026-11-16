import { IMAGE_ORIGINS } from "./origins";

const allow = document.getElementById("allow") as HTMLButtonElement;
const status = document.getElementById("status")!;

async function show() {
  const granted = await chrome.permissions.contains({ origins: IMAGE_ORIGINS });
  allow.hidden = granted;
  status.textContent = granted ? "Allowed. Go back to the pull request: pairs with different widths now line up by themselves." : "";
}

allow.addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins: IMAGE_ORIGINS });
  if (!granted) status.textContent = "Not allowed. You can still line pairs up with Left, Center or Right.";
  await show();
});
show();
