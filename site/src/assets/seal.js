// @ts-check
// The security section's demo: the body scrambles into ciphertext, a signature
// streams in, and the check mark draws. Decorative (aria-hidden), and the
// bytes are random, not real crypto. Reduced motion shows the finished state.
(() => {
  const demo = document.querySelector("[data-seal]");
  if (!demo) return;
  const cipher = /** @type {HTMLElement} */ (demo.querySelector("[data-seal-cipher]"));
  const sig = /** @type {HTMLElement} */ (demo.querySelector("[data-seal-sig]"));
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const HEX = "0123456789abcdef";
  const random = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const finalCipher = random(B64, 64) + "=";
  const finalSig = random(HEX, 64);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cipher.textContent = finalCipher;
    sig.textContent = finalSig;
    demo.classList.add("is-verified");
    return;
  }

  /** One pass: scramble the ciphertext, stream the signature, verify, hold, repeat. */
  function run() {
    demo.classList.remove("is-verified");
    sig.textContent = " ";
    const t0 = performance.now();
    function tick(now) {
      const t = now - t0;
      if (t < 1400) {
        // The settled prefix grows while the tail keeps scrambling.
        const settled = Math.floor((t / 1400) * finalCipher.length);
        cipher.textContent = finalCipher.slice(0, settled) + random(B64, finalCipher.length - settled);
      } else if (t < 2400) {
        cipher.textContent = finalCipher;
        sig.textContent = finalSig.slice(0, Math.floor(((t - 1400) / 1000) * finalSig.length)) || " ";
      } else {
        sig.textContent = finalSig;
        demo.classList.add("is-verified");
        setTimeout(run, 5000);
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  // Start when it scrolls into view, once.
  new IntersectionObserver((entries, observer) => {
    if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); run(); }
  }).observe(demo);
})();
