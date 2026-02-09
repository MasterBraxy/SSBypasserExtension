// background.js - central automation controller

const STORE_KEY = "ssbAutomationState";
const DEFAULT_STATE = {
  running: false,
  tabId: null,
  cycle: 0,
  stage: "idle",
  startedAt: null,
  lastUrl: null
};
const VERIFY_ENTRY_URL = "https://stark.vidyarays.com/";
const PORTAL_ENTRY_URL = "https://studystark.com/";
const PROLINK_PATH = "/prolink.php";
const MAX_CYCLES = 5;
const HOST_RULES = [
  { type: "exact", value: "studystark.in" },
  { type: "exact", value: "stark.vidyarays.com" },
  { type: "suffix", value: ".vidyarays.com" },
  { type: "exact", value: "studystark.com" },
  { type: "suffix", value: ".studystark.com" },
  { type: "suffix", value: ".studystark.in" }
];
const PORTAL_HOSTS = [
  "studystark.in",
  "studystark.com",
  "www.studystark.com",
  "www.studystark.in",
  "temporaray.studystark.in",
  "*.studystark.com",
  "*.studystark.in"
];
const VERIFY_HOSTS = ["stark.vidyarays.com"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  return { ...DEFAULT_STATE, ...(stored[STORE_KEY] || {}) };
}

async function writeState(next) {
  await chrome.storage.local.set({ [STORE_KEY]: next });
  await updateBadge(next);
  return next;
}

async function updateState(patch) {
  const current = await readState();
  return writeState({ ...current, ...patch });
}

async function updateBadge(state) {
  if (!state.running) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1849d6" });
  const label = Math.min(MAX_CYCLES, state.cycle + 1).toString();
  await chrome.action.setBadgeText({ text: label });
}

function matchesAllowed(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return HOST_RULES.some((rule) => {
      if (rule.type === "exact") {
        return host === rule.value;
      }
      if (rule.type === "suffix") {
        const suffix = rule.value;
        return host === suffix.slice(1) || host.endsWith(suffix);
      }
      return false;
    });
  } catch (err) {
    return false;
  }
}

async function fetchTab(tabId) {
  if (typeof tabId !== "number") return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (err) {
    return null;
  }
}

async function injectRunner(tabId) {
  if (typeof tabId !== "number") return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_isolated.js"]
    });
  } catch (err) {
    if (!/Frame|removed/i.test(err?.message || "")) {
      console.warn("[BG] Injection failed", err?.message);
    }
  }
}

async function resetMainWorldTimer(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const stamp = Date.now();
      const zeroVars = () => {
        const keys = ["timeCount", "timecount", "timer", "countdown", "time"];
        for (const key of keys) {
          try {
            Object.defineProperty(window, key, {
              value: 0,
              writable: true,
              configurable: true
            });
          } catch (err) {
            window[key] = 0;
          }
        }
      };
      const zeroDom = () => {
        const selectors = [
          "#timer",
          ".timer",
          '[id*="timer" i]',
          '[class*="timer" i]'
        ];
        const nodes = document.querySelectorAll(selectors.join(","));
        nodes.forEach((node) => {
          node.textContent = "0";
          node.innerText = "0";
        });
      };
      const stopIntervals = () => {
        const native = window.setInterval;
        const collected = [];
        window.setInterval = function (...args) {
          const id = native.apply(this, args);
          collected.push(id);
          return id;
        };
        setTimeout(() => {
          collected.forEach((id) => {
            try {
              clearInterval(id);
            } catch (err) {
              /* noop */
            }
          });
          window.setInterval = native;
        }, 250);
      };

      zeroVars();
      zeroDom();
      stopIntervals();

      const interval = setInterval(() => {
        zeroVars();
        zeroDom();
      }, 8);
      setTimeout(() => {
        clearInterval(interval);
        console.debug(`[SSB] Timer pinned for ${Date.now() - stamp}ms`);
      }, 12000);
    }
  });
}

async function resetAutomationState() {
  return writeState({ ...DEFAULT_STATE });
}

async function startAutomation(tab) {
  let targetTab = tab;
  if (!matchesAllowed(targetTab?.url)) {
    targetTab = await chrome.tabs.create({ url: PORTAL_ENTRY_URL, active: true });
    await sleep(800);
  }

  if (!targetTab?.id) {
    console.warn("[BG] Missing tab id while starting automation");
    return;
  }

  await writeState({
    ...DEFAULT_STATE,
    running: true,
    tabId: targetTab.id,
    cycle: 0,
    stage: "boot",
    startedAt: Date.now(),
    lastUrl: targetTab.url || PORTAL_ENTRY_URL
  });

  await injectRunner(targetTab.id);
  console.info(`[BG] Automation started on tab ${targetTab.id}`);
}

async function stopAutomation(reason = "user") {
  await resetAutomationState();
  console.info(`[BG] Automation stopped (${reason})`);
}

chrome.runtime.onInstalled.addListener(resetAutomationState);

chrome.action.onClicked.addListener(async (tab) => {
  const state = await readState();
  if (state.running) {
    await stopAutomation("toggle");
    return;
  }
  await startAutomation(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const state = await readState();
  if (!state.running || tabId !== state.tabId) return;
  await updateState({ lastUrl: tab.url || null });
  await injectRunner(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await readState();
  if (state.running && state.tabId === tabId) {
    await stopAutomation("tab_closed");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "CONTENT_READY":
      handleContentReady(sender, sendResponse);
      return true;
    case "AUTOMATION_STAGE":
      handleStageUpdate(msg, sendResponse);
      return true;
    case "REQUEST_TIMER_RESET":
      handleTimerReset(sender, sendResponse);
      return true;
    case "AUTOMATION_CYCLE_COMPLETE":
      handleCycleComplete(sendResponse);
      return true;
    case "AUTOMATION_FINISHED":
      handleAutomationFinished(sendResponse);
      return true;
    case "AUTOMATION_ERROR":
      handleAutomationError(msg, sendResponse);
      return true;
    case "AUTOMATION_LOG":
      console.log(`[Content] ${msg.message || "log"}`);
      sendResponse?.({ ok: true });
      return;
    default:
      return;
  }
});

async function handleContentReady(sender, sendResponse) {
  const state = await readState();
  const tabId = sender.tab?.id;
  const permitted = state.running && tabId === state.tabId;
  if (!permitted) {
    sendResponse?.({ run: false });
    return;
  }
  sendResponse?.({
    run: true,
    cycle: state.cycle,
    stage: state.stage,
    config: {
      verifyEntryUrl: VERIFY_ENTRY_URL,
      portalEntryUrl: PORTAL_ENTRY_URL,
      prolinkPath: PROLINK_PATH,
      maxCycles: MAX_CYCLES,
      portalHosts: PORTAL_HOSTS,
      verifyHosts: VERIFY_HOSTS
    }
  });
}

async function handleStageUpdate(msg, sendResponse) {
  const stage = typeof msg.stage === "string" ? msg.stage.slice(0, 32) : "running";
  await updateState({ stage });
  sendResponse?.({ ok: true });
}

async function handleTimerReset(sender, sendResponse) {
  const tabId = sender.tab?.id;
  const state = await readState();
  if (!state.running || tabId !== state.tabId) {
    sendResponse?.({ ok: false, error: "NOT_ACTIVE" });
    return;
  }
  try {
    const started = Date.now();
    await resetMainWorldTimer(tabId);
    sendResponse?.({ ok: true, duration: Date.now() - started });
  } catch (err) {
    console.error("[BG] Timer reset failed", err);
    sendResponse?.({ ok: false, error: err?.message || "RESET_FAILED" });
  }
}

async function handleCycleComplete(sendResponse) {
  const state = await readState();
  const nextCycle = Math.min(MAX_CYCLES, state.cycle + 1);
  const updated = await updateState({ cycle: nextCycle });
  sendResponse?.({ ok: true, cycle: updated.cycle });
}

async function handleAutomationError(msg, sendResponse) {
  console.error(`[Content] ${msg.message || "Unknown error"}`);
  await stopAutomation("content_error");
  sendResponse?.({ ok: true });
}

async function handleAutomationFinished(sendResponse) {
  await stopAutomation("completed");
  sendResponse?.({ ok: true });
}