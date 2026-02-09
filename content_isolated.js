// content_isolated.js - DOM-side automation
(async () => {
  if (globalThis.__SSB_AUTOMATION_ACTIVE) return;
  globalThis.__SSB_AUTOMATION_ACTIVE = true;

  const SELECTORS = {
    server: ".server",
    generate: ".generate-btn",
    continueBtn: "#continue-show",
    verifyBtn: "#verifyBtn",
    finalLink: "#final-get-link"
  };

  const INTERACTIVE_SELECTOR = "button, a, [role='button'], div[role='button'], span[role='button']";
  const KEY_INPUT_SELECTOR = "input[name*='key' i], input[placeholder*='key' i], input[type='text'], input[type='search']";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isVisible = (node) => {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) > 0
    );
  };

  const gatherInteractiveNodes = () => {
    const base = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const extras = Array.from(
      document.querySelectorAll(".server, .server button, .generate-btn")
    );
    return base.concat(extras);
  };

  const findButtonByText = (terms = []) => {
    if (!terms.length) return null;
    const lowered = terms.map((term) => term.toLowerCase());
    return (
      gatherInteractiveNodes().find((node) => {
        if (!node || typeof node.click !== "function" || node.disabled) {
          return false;
        }
        if (!isVisible(node)) return false;
        const text = node.textContent?.trim().toLowerCase();
        if (!text) return false;
        return lowered.some((term) => text.includes(term));
      }) || null
    );
  };

  const getKeyField = () => document.querySelector(KEY_INPUT_SELECTOR);

  const sendMessage = (type, payload = {}, timeout = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Message timeout: ${type}`)), timeout);
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

  const waitFor = (selector, timeout = 20000) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        const node = document.querySelector(selector);
        if (node) {
          clearInterval(poll);
          resolve(node);
          return;
        }
        if (Date.now() - start > timeout) {
          clearInterval(poll);
          reject(new Error(`Timeout waiting for ${selector}`));
        }
      }, 120);
    });

  const log = (message) => sendMessage("AUTOMATION_LOG", { message });
  const stage = (value) => sendMessage("AUTOMATION_STAGE", { stage: value });

  class Automator {
    constructor(handshake) {
      this.cycle = handshake.cycle ?? 0;
      this.config = handshake.config || {};
      this.hostname = location.hostname;
    }

    async start() {
      if (this.isPortalHost()) {
        await this.handlePortalLanding();
        return;
      }

      await log(`[Runner] Cycle ${this.cycle + 1}`);
      if (this.isProlinkPage()) {
        await this.handleProlink();
        return;
      }
      if (await this.tryGeneratorPage()) {
        return;
      }
      await this.handleVerifyPage();
    }

    isPortalHost() {
      return this.matchesHostList(this.config.portalHosts) || this.hostname.includes("studystark");
    }

    matchesHostList(list = []) {
      if (!Array.isArray(list)) return false;
      return list.some((pattern) => {
        if (!pattern) return false;
        if (pattern.startsWith("*.")) {
          const bare = pattern.slice(2);
          const suffix = pattern.slice(1);
          return this.hostname === bare || this.hostname.endsWith(suffix);
        }
        return this.hostname === pattern;
      });
    }

    isProlinkPage() {
      try {
        const current = new URL(location.href);
        return current.pathname.includes(this.config.prolinkPath);
      } catch (err) {
        return false;
      }
    }

    async handlePortalLanding() {
      await stage("portal_entry");

      if (!this.hasKeyReady()) {
        await this.triggerPortalGeneration();
        return;
      }

      await stage("portal_verify");
      await this.clickVerifyKey();
    }

    async triggerPortalGeneration() {
      await stage("portal_generate");
      const serverBtn = this.findPortalServerButton();
      if (serverBtn) {
        serverBtn.click();
        await sleep(900);
      } else {
        await log("Portal: server button missing");
      }

      try {
        const generateBtn = await waitFor(SELECTORS.generate, 7000);
        if (generateBtn && generateBtn !== serverBtn) {
          generateBtn.click();
          await sleep(800);
        }
      } catch (err) {
        await log(`Portal: generate button missing (${err.message})`);
      }
    }

    async clickVerifyKey() {
      const verifyBtn = this.findButtonByKeywords(["verify key", "verify"]);
      if (verifyBtn && this.hasKeyReady()) {
        verifyBtn.click();
        await sleep(1200);
        return;
      }
      await log("Portal: verify button not ready yet");
    }

    async handleProlink() {
      await stage("prolink_redirect");
      await sleep(4000);
      window.location.replace(this.config.verifyEntryUrl);
    }

    async tryGeneratorPage() {
      const server =
        document.querySelector(SELECTORS.server) ||
        this.findButtonByKeywords(["server"]);
      const generate =
        document.querySelector(SELECTORS.generate) ||
        this.findButtonByKeywords(["generate"]);
      if (!generate) return false;
      await stage("generator");
      if (server && server !== generate) {
        server.click();
        await sleep(600);
      }
      generate.click();
      await log("Generator clicked, jumping to Step 4");
      await sleep(3500);
      if (!location.href.startsWith(this.config.verifyEntryUrl)) {
        window.location.href = this.config.verifyEntryUrl;
      }
      return true;
    }

    async handleVerifyPage() {
      const lastCycle = this.cycle >= (this.config.maxCycles - 1);
      await stage(lastCycle ? "final_cycle" : `cycle_${this.cycle + 1}`);
      await this.resetCountdown();

      if (!lastCycle) {
        await this.clickContinue();
      }

      await this.clickVerify();
      await this.advanceCycle();

      if (lastCycle) {
        await this.openFinalLink();
        await sendMessage("AUTOMATION_FINISHED");
      }
    }

    async resetCountdown() {
      const resp = await sendMessage("REQUEST_TIMER_RESET");
      if (!resp?.ok) {
        throw new Error(resp?.error || "RESET_TIMER_FAILED");
      }
      await log(`Timer reset in ${resp.duration || 0}ms`);
    }

    async clickContinue() {
      try {
        const btn = await waitFor(SELECTORS.continueBtn, 8000);
        btn.click();
        await sleep(1500);
      } catch (err) {
        await log(`Continue not found: ${err.message}`);
      }
    }

    async clickVerify() {
      const btn = await waitFor(SELECTORS.verifyBtn, 20000);
      btn.click();
      await sleep(1200);
    }

    async openFinalLink() {
      await log("Attempting final link");
      try {
        const finalBtn = await waitFor(SELECTORS.finalLink, 12000);
        finalBtn.click();
        return;
      } catch (err) {
        await log(`Final link not found: ${err.message}`);
      }
      document.querySelector(SELECTORS.verifyBtn)?.click();
    }

    async advanceCycle() {
      const resp = await sendMessage("AUTOMATION_CYCLE_COMPLETE");
      if (resp?.cycle !== undefined) {
        this.cycle = resp.cycle;
      }
    }

    hasKeyReady() {
      const field = getKeyField();
      const value = field?.value?.trim();
      return Boolean(value && value.length >= 6);
    }

    findPortalServerButton() {
      return (
        document.querySelector(".server button") ||
        document.querySelector(".server") ||
        this.findButtonByKeywords(["generate key", "server"])
      );
    }

    findButtonByKeywords(keywords) {
      return findButtonByText(keywords);
    }
  }

  try {
    const handshake = await sendMessage("CONTENT_READY", { url: location.href });
    if (!handshake?.run) {
      globalThis.__SSB_AUTOMATION_ACTIVE = false;
      return;
    }
    const automator = new Automator(handshake);
    await automator.start();
    globalThis.__SSB_AUTOMATION_ACTIVE = false;
  } catch (err) {
    await sendMessage("AUTOMATION_ERROR", { message: err?.message || String(err) });
    console.error("[SSB] Automation failed", err);
    globalThis.__SSB_AUTOMATION_ACTIVE = false;
  }
})();