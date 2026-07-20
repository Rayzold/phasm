// "global": true in manifest.json is what makes this fire even while a different window (the
// game) has OS focus — regular (non-global) commands only fire while Chrome itself is focused.
//
// The toolbar badge is debug feedback: it tells you the hotkey reached the extension at all,
// which you can't otherwise see while alt-tabbed into a fullscreen game.
//   "..." grey  = command received, still looking for the tab / about to inject
//   "OK"  green = found voice.html and sent the toggle
//   "NO"  red   = no open tab matched voice.html — open it first
//   "ERR" red   = the tab was found but the page-side function wasn't reachable
//     (AI mode probably isn't armed/ready yet on that tab, or it needs a reload)
function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
}

chrome.commands.onCommand.addListener(async (command) => {
  console.log("[phasmo-ptt] command received:", command);
  if (command !== "ptt-toggle") return;

  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter(t => t.url && t.url.includes("voice.html"));
  console.log("[phasmo-ptt] matching tabs:", tabs.map(t => t.url));

  if (!tabs.length) {
    flashBadge("NO", "#E15B5B");
    return;
  }

  for (const tab of tabs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN", // runs in the page's own JS context, so it can call the page's function directly
        func: () => {
          if (typeof window.pttHotkeyToggle === "function") {
            window.pttHotkeyToggle();
            return "called";
          }
          return "missing";
        },
      });
      console.log("[phasmo-ptt] injected into", tab.url, "->", result);
      flashBadge(result === "called" ? "OK" : "ERR", result === "called" ? "#57996b" : "#E15B5B");
    } catch (err) {
      console.log("[phasmo-ptt] inject failed on", tab.url, err);
      flashBadge("ERR", "#E15B5B");
    }
  }
});
