// "global": true in manifest.json is what makes this fire even while a different window (the
// game) has OS focus — regular (non-global) commands only fire while Chrome itself is focused.
const TARGET_URL_PATTERN = "https://rayzold.github.io/phasm/voice.html*";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "ptt-toggle") return;

  const tabs = await chrome.tabs.query({ url: TARGET_URL_PATTERN });
  if (!tabs.length) return; // voice.html isn't open anywhere — nothing to toggle

  for (const tab of tabs) {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        world: "MAIN", // runs in the page's own JS context, so it can call the page's function directly
        func: () => {
          if (typeof window.pttHotkeyToggle === "function") window.pttHotkeyToggle();
        },
      })
      .catch(() => {
        /* tab may have navigated away or closed between query and inject — ignore */
      });
  }
});
