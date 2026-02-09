// content_isolated.js
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const getStore = (keys) =>
    new Promise(r => chrome.storage.local.get(keys, r));
  const setStore = (obj) =>
    new Promise(r => chrome.storage.local.set(obj, r));

  const waitFor = (sel, t = 20000) =>
    new Promise((res, rej) => {
      const s = Date.now();
      const i = setInterval(() => {
        const el = document.querySelector(sel);
        if (el) { clearInterval(i); res(el); }
        if (Date.now() - s > t) {
          clearInterval(i); rej("timeout " + sel);
        }
      }, 120);
    });

  const sendMessage = (payload, timeout = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Message timeout: " + payload.type));
      }, timeout);

      chrome.runtime.sendMessage(payload, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

  const resetTimer = async () => {
    const started = performance.now();
    const resp = await sendMessage({ type: "RESET_TIMER" }, 8000);
    if (!resp?.ok) {
      throw new Error(resp?.error || "RESET_TIMER_FAILED");
    }
    const duration = resp.duration ?? performance.now() - started;
    console.log(`[Automation] Timer reset ack in ${Math.round(duration)}ms`);
    return duration;
  };

  const state = await getStore({ running: false, step: 1, cycle: 0 });
  if (!state.running) return;

  let { step, cycle } = state;

  console.log("[Automation] injected:", location.href, state);

  const step4Url = "https://stark.vidyarays.com/";
  const prolinkUrl = "https://stark.vidyarays.com/prolink.php?id=oLVxwuFfBVs6Lbz65EhR5jBucjBRTlozeVp1ekZVV1dXc0ZCeUVBK1U2TXovQjZIVTZBWkR3MDNrWDFhdk5sSWh0UktGeHFwVWxudHllOWk";

  // Redirect any generated prolink straight back to the Vidyarays home page
  if (location.href.startsWith(prolinkUrl)) {
    console.log("[Automation] Prolink detected, waiting before redirecting to Vidyarays");
    await sleep(4000); // allow destination to register the visit
    window.location.replace(step4Url);
    return;
  }

  // STEP 1 — server + generate
  if (step === 1) {
    const server = document.querySelector(".server");
    const gen = document.querySelector(".generate-btn");

    if (server && gen) {
      server.click();
      await sleep(800);
      gen.click();
      console.log("[Automation] Generate clicked, waiting for site to load...");
      await sleep(4000);
      await setStore({ step: 4, cycle: 0 });
      // Jump straight to the first Step 4 page after triggering generation
      if (!location.href.startsWith(step4Url)) {
        window.location.href = step4Url;
      }
      return;
    }
  }

  // STEP 2 — timer redirect page (do nothing)
  if (step === 2) {
    const a = document.querySelector("a.zReHs");
    if (a) {
      a.click();
      await setStore({ step: 4, cycle: 0 });
    }
    return;
  }

  // STEP 4 — verify cycles
  if (step === 4) {

    if (cycle >= 5) {
      console.log("[Automation] Final page - resetting timer");

      // 🔥 RESET TIMER ON FINAL PAGE
      await resetTimer();
      
      const finalLink = document.getElementById("final-get-link");
      if (finalLink) finalLink.click();
      await setStore({ running: false });
      console.log("[Automation] DONE");
      return;
    }

    // 5th cycle (cycle === 4) — Reset time → Verify (no Continue button)
    if (cycle === 4) {
      console.log(`[Automation] Page 5/5 - Reset time → Verify only`);

      // 🔥 RESET TIMER
      await resetTimer();

      // Click Verify button directly (no Continue button on page 5)
      console.log("[Automation] Looking for Verify button (#verifyBtn)...");
      const verifyBtn = await waitFor("#verifyBtn", 20000);
      console.log("[Automation] Verify button found on page 5, clicking...");
      verifyBtn.click();
      await sleep(1000);

      await setStore({ cycle: cycle + 1 });
      return;
    }

    // Cycles 1-4 (cycle 0-3) — Reset time → Continue → Verify
    console.log(`[Automation] Page ${cycle + 1}/5 - Reset time → Continue → Verify`);

    // 🔥 RESET TIMER FIRST
    await resetTimer();

    // Click Continue (if it exists)
    try {
      console.log("[Automation] Looking for Continue button (#continue-show)...");
      try {
        const cont = await waitFor("#continue-show", 5000);
        console.log("[Automation] Continue button found, clicking...");
        cont.click();
        console.log("[Automation] Continue clicked, waiting for Verify button...");
        await sleep(2000);
      } catch (continueErr) {
        console.log("[Automation] Continue button not found, checking for Verify directly...");
      }

      // Wait for Verify button to appear (up to 20 seconds)
      console.log("[Automation] Looking for Verify button (#verifyBtn)...");
      const verifyBtn = await waitFor("#verifyBtn", 20000);
      console.log("[Automation] Verify button found, clicking...");
      verifyBtn.click();
      await sleep(1000);

      await setStore({ cycle: cycle + 1 });
    } catch (err) {
      console.error("[Automation] ERROR on cycle", cycle, ":", err);
      console.log("[Automation] Available buttons:", 
        document.querySelectorAll("button, a, [id*='continue'], [id*='verify']"));
      await setStore({ running: false }); // Stop automation on error
    }
    return;
  }
})();