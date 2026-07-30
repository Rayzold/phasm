// "global": true in manifest.json is what makes these fire even while a different window (the
// game) has OS focus — regular (non-global) commands only fire while Chrome itself is focused.
//
// Each command maps to a bridge function voice.html exposes on window (see the "global hotkey
// bridge" comment there). Reset isn't wired up on purpose — it wipes the whole board, too
// destructive for a hotkey you can't see the confirmation of while alt-tabbed into the game.
const COMMAND_BRIDGE = {
  "ptt-toggle": "pttHotkeyToggle",
  "mute-toggle": "muteHotkeyToggle",
  "undo-last": "undoHotkeyToggle",
};

// The toolbar badge is debug feedback: it tells you the hotkey reached the extension at all,
// which you can't otherwise see while alt-tabbed into a fullscreen game.
//   "OK"  green = found voice.html and called the bridge function
//   "NO"  red   = no open tab matched voice.html — open it first
//   "ERR" red   = the tab was found but the page-side function wasn't reachable
//     (for ptt-toggle specifically: AI mode probably isn't armed/ready yet, or the tab needs a reload)
function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
}

chrome.commands.onCommand.addListener(async (command) => {
  console.log("[phasmo-hotkeys] command received:", command);
  const bridgeFn = COMMAND_BRIDGE[command];
  if (!bridgeFn) return;

  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter(t => t.url && t.url.includes("voice.html"));
  console.log("[phasmo-hotkeys] matching tabs:", tabs.map(t => t.url));

  if (!tabs.length) {
    flashBadge("NO", "#E15B5B");
    return;
  }

  for (const tab of tabs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN", // runs in the page's own JS context, so it can call the page's function directly
        func: (fnName) => {
          if (typeof window[fnName] === "function") {
            window[fnName]();
            return "called";
          }
          return "missing";
        },
        args: [bridgeFn],
      });
      console.log("[phasmo-hotkeys] injected", bridgeFn, "into", tab.url, "->", result);
      flashBadge(result === "called" ? "OK" : "ERR", result === "called" ? "#57996b" : "#E15B5B");
    } catch (err) {
      console.log("[phasmo-hotkeys] inject failed on", tab.url, err);
      flashBadge("ERR", "#E15B5B");
    }
  }
});
