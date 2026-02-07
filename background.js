// background.js (Manifest V3 service worker)

// ---- storage helpers ----
const getStore = (keys) =>
  new Promise((res) => chrome.storage.local.get(keys, res));
const setStore = (obj) =>
  new Promise((res) => chrome.storage.local.set(obj, res));

// ---- inject content script ----
async function inject(tabId) {
  try {
    // Small delay to ensure frame is ready
    await new Promise(r => setTimeout(r, 500));
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_isolated.js"]
    });
    console.log("[BG] Script injected successfully");
  } catch (e) {
    // Silently handle frame removal errors (normal during redirects)
    if (!e.message?.includes("Frame") && !e.message?.includes("removed")) {
      console.error("[BG] inject failed", e);
    }
  }
}

// ---- RESET timer in MAIN world (CSP-safe) ----
async function resetTimeCount(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        console.log("[EXT] Starting ultra-persistent timer reset");
        
        // 1. Lock timeCount to 0 using defineProperty
        try {
          Object.defineProperty(window, 'timeCount', {
            value: 0,
            writable: true,
            configurable: true
          });
          console.log("[EXT] Locked timeCount property");
        } catch (e) {
          console.log("[EXT] defineProperty failed, using fallback");
        }
        
        // 2. Aggressively reset all timer variables
        const resetTimer = () => {
          // Main variable
          if (typeof window.timeCount !== "undefined") {
            window.timeCount = 0;
          }
          // Common variations
          if (typeof window.timecount !== "undefined") {
            window.timecount = 0;
          }
          if (typeof window.timer !== "undefined") {
            window.timer = 0;
          }
          if (typeof window.countdown !== "undefined") {
            window.countdown = 0;
          }
          if (typeof window.time !== "undefined") {
            window.time = 0;
          }
          
          // Also manipulate DOM timer display
          const timerEl = document.getElementById('timer') || 
                         document.querySelector('.timer') ||
                         document.querySelector('[id*="timer"]') ||
                         document.querySelector('[class*="timer"]');
          if (timerEl) {
            timerEl.textContent = '0';
            timerEl.innerText = '0';
          }
        };
        
        // 3. Reset immediately
        resetTimer();
        
        // 4. Keep resetting for 15 seconds (longer duration)
        const interval = setInterval(resetTimer, 5); // Every 5ms
        setTimeout(() => {
          clearInterval(interval);
          console.log("[EXT] Timer reset complete - timeCount =", window.timeCount);
        }, 15000);
        
        // 5. Also try to stop any setInterval that might be updating the timer
        const originalSetInterval = window.setInterval;
        const intervals = [];
        window.setInterval = function(...args) {
          const id = originalSetInterval.apply(this, args);
          intervals.push(id);
          return id;
        };
        
        // Clear any existing intervals after a short delay
        setTimeout(() => {
          intervals.forEach(id => {
            try { clearInterval(id); } catch(e) {}
          });
          console.log("[EXT] Cleared", intervals.length, "intervals");
        }, 100);
      }
    });
  } catch (e) {
    console.error("[BG] resetTimeCount failed", e);
  }
}

// ---- icon click = start/stop ----
chrome.action.onClicked.addListener(async (tab) => {
  const { running } = await getStore({ running: false });

  if (!running) {
    await setStore({
      running: true,
      step: 1,
      cycle: 0,
      tabId: tab.id
    });
    await inject(tab.id);
    console.log("[BG] Automation STARTED");
  } else {
    await setStore({ running: false });
    console.log("[BG] Automation STOPPED");
  }
});

// ---- reinject after every redirect ----
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;

  const { running, tabId: storedTab } =
    await getStore({ running: false, tabId: null });

  if (running && tabId === storedTab) {
    // Additional delay to ensure page is fully loaded
    await new Promise(r => setTimeout(r, 800));
    await inject(tabId);
  }
});

// ---- messages from content ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "RESET_TIMER") return;

  const tabId = sender.tab?.id || msg.tabId;
  if (!tabId) {
    sendResponse?.({ ok: false, error: "NO_TAB_ID" });
    return;
  }

  (async () => {
    const started = Date.now();
    try {
      await resetTimeCount(tabId);
      sendResponse?.({ ok: true, duration: Date.now() - started });
    } catch (error) {
      console.error("[BG] resetTimeCount error", error);
      sendResponse?.({ ok: false, error: error?.message || "RESET_FAILED" });
    }
  })();

  return true; // keep message channel open for async response
});
