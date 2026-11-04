// @ts-check
// The hero: a slowly turning spiral galaxy. Now and then two of its stars
// reveal themselves as agents and an envelope arcs between them. Purely
// decorative (aria-hidden); with reduced motion it draws one still frame.
//
// Performance: the disc (2,600 stars and the gas clouds) is painted once,
// face-on, into an offscreen texture. Each frame draws that texture through
// a rotate-then-tilt transform, plus a few hundred twinkling stars and the
// live conversations, so a frame costs one drawImage and stays at the
// display's refresh rate (120 Hz on ProMotion screens).
(() => {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector("[data-galaxy]"));
  if (!canvas) return;
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) return;
  const ctx = maybeCtx;
  const toggle = /** @type {HTMLButtonElement | null} */ (document.querySelector("[data-galaxy-toggle]"));
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const AGENT_COUNT = 14;
  const EXCHANGES = [["ask", "reply"], ["ask", "reply"], ["ask", "promise"], ["hello", "hello"], ["ask", "waiting"], ["promise", "fulfil"]];
  const PALETTE = ["#cfe0ff", "#ffffff", "#b9c8ff", "#c79bff", "#ff9bd6", "#8ff0ff", "#fff2c8"];
  const ARM_TWIST = 5.6;
  const TILT = 0.56;
  /** The texture reaches past the outermost star so the arm clouds aren't clipped. */
  const REACH = 1.25;

  let width = 0, height = 0, cx = 0, cy = 0, scale = 1, dpr = 1;
  /** @type {{r:number,a:number,s:number,c:string,tw:number,agent:number,live:boolean}[]} */
  let stars = [];
  /** @type {{a:number,b:number,born:number,tags:string[]}[]} */
  let talks = [];
  let rotation = 0;
  let last = 0;
  let nextTalk = 0;
  let running = false;
  let paused = false;
  let signal = "#8ff0ff";
  /** @type {HTMLCanvasElement} */
  const disc = document.createElement("canvas");

  // Seeded, so the galaxy has the same shape on every load.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  function build() {
    seed = 7;
    stars = [];
    const ARMS = 3;
    for (let i = 0; i < 2600; i++) {
      const halo = rand() < 0.18;
      const r = halo ? Math.pow(rand(), 0.55) : Math.pow(rand(), 0.8);
      const arm = (i % ARMS) * ((Math.PI * 2) / ARMS);
      // Spiral arms: angle grows with radius; scatter is gaussian-ish, tight near the core.
      const spread = (rand() + rand() + rand() - 1.5) * (0.18 + r * 0.42);
      const a = halo ? rand() * Math.PI * 2 : arm + r * ARM_TWIST + spread;
      const s = rand() < 0.05 ? 2.1 : 0.7 + rand() * 1.2;
      // About one star in ten twinkles, drawn live; the rest live in the texture.
      stars.push({ r: 0.03 + r * 0.97, a, s, c: PALETTE[Math.floor(rand() * PALETTE.length)], tw: rand() * Math.PI * 2, agent: -1, live: rand() < 0.1 });
    }
    // Agents live in the mid disc, where they are easy to see and never in the core's glare.
    const candidates = stars.filter((s) => s.r > 0.3 && s.r < 0.85 && s.s < 1.9);
    for (let n = 0; n < AGENT_COUNT; n++) {
      const pick = candidates[Math.floor((n + 0.5) * (candidates.length / AGENT_COUNT))];
      if (pick) pick.agent = n;
    }
  }

  // Gas clouds sit along the arms, so the colour swirls with the stars.
  const ARM_COLORS = ["124,92,255", "255,86,168", "60,206,212"];
  const CLOUDS = [
    { r: 0.03, a: 0, size: 0.34, color: "255,220,170", alpha: 0.55 },
    { r: 0.03, a: 0, size: 0.75, color: "160,120,255", alpha: 0.16 },
    ...[0, 1, 2].flatMap((arm) =>
      [0.22, 0.42, 0.62, 0.84].map((r, k) => ({ r, a: arm * ((Math.PI * 2) / 3) + r * ARM_TWIST, size: 0.2 + r * 0.22, color: ARM_COLORS[(arm + k) % 3], alpha: 0.2 - r * 0.1 })),
    ),
  ];

  /** Paints the face-on disc once per size. The tilt is applied when it's drawn, so circles here become the ellipse on screen. */
  function paintDisc() {
    const half = REACH * scale;
    // Cap the texture so a big screen doesn't allocate a huge bitmap; smoothing covers the rest.
    const texScale = Math.min(dpr, 2400 / (half * 2));
    disc.width = disc.height = Math.ceil(half * 2 * texScale);
    const d = /** @type {CanvasRenderingContext2D} */ (disc.getContext("2d"));
    d.setTransform(texScale, 0, 0, texScale, half * texScale, half * texScale);
    d.globalCompositeOperation = "lighter";
    for (const c of CLOUDS) {
      const x = Math.cos(c.a) * c.r * scale, y = Math.sin(c.a) * c.r * scale;
      // Clouds are drawn round here and squashed by the tilt, matching the old on-screen look.
      const g = d.createRadialGradient(x, y, 0, x, y, c.size * scale);
      g.addColorStop(0, `rgba(${c.color},${c.alpha})`);
      g.addColorStop(1, `rgba(${c.color},0)`);
      d.fillStyle = g;
      d.fillRect(-half, -half, half * 2, half * 2);
    }
    d.globalCompositeOperation = "source-over";
    for (const s of stars) {
      if (s.live) continue;
      d.globalAlpha = Math.min(1, 0.8 * (1.35 - s.r * 0.45));
      d.fillStyle = s.c;
      const x = Math.cos(s.a) * s.r * scale, y = Math.sin(s.a) * s.r * scale;
      // Round dots: the disc turns before the tilt, so any pre-stretch would smear into slanted slivers.
      d.beginPath();
      d.arc(x, y, s.s * 0.6, 0, Math.PI * 2);
      d.fill();
    }
    d.globalAlpha = 1;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const wide = width > 860;
    cx = wide ? width * 0.64 : width * 0.5;
    cy = wide ? height * 0.5 : height * 0.3;
    scale = Math.min(wide ? width * 0.42 : width * 0.66, height * (wide ? 0.8 : 0.5));
    signal = getComputedStyle(document.documentElement).getPropertyValue("--galaxy-signal").trim() || "#8ff0ff";
    paintDisc();
  }

  // The arms turn as one pattern (a density wave), so the spiral never winds itself up.
  function position(s) {
    const a = s.a + rotation;
    return { x: cx + Math.cos(a) * s.r * scale, y: cy + Math.sin(a) * s.r * scale * TILT };
  }

  /** Only agents clear of the headline and copy light up, so a conversation never runs under text. */
  function clear(s) {
    const p = position(s);
    return width > 860 ? p.x > width * 0.5 && p.x < width - 40 && p.y > 40 && p.y < height - 60 : p.y > 24 && p.y < height * 0.42;
  }

  function drawLiveStars(time) {
    for (const s of stars) {
      if (!s.live) continue;
      const { x, y } = position(s);
      const twinkle = still ? 0.8 : 0.55 + 0.45 * Math.sin(time * 0.0016 + s.tw);
      ctx.globalAlpha = Math.min(1, twinkle * (1.35 - s.r * 0.45));
      ctx.fillStyle = s.c;
      ctx.fillRect(x - s.s / 2, y - s.s / 2, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp = (v) => Math.max(0, Math.min(1, v));

  // One conversation: reveal (0-0.6s), envelope out (0.6-2.2s), answer back (2.4-4s), fade (4-5.2s).
  const TALK_MS = 5200;
  function drawTalk(talk, time) {
    const age = still ? 3200 : time - talk.born;
    const A = position(stars[talk.a]);
    const B = position(stars[talk.b]);
    const reveal = clamp(age / 600) * (1 - clamp((age - 4000) / 1200));
    // A curve that bows toward the core, so paths read as travel through the galaxy.
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const ctrl = { x: mx + (cx - mx) * 0.45, y: my + (cy - my) * 0.45 - 18 };
    const at = (t, from, to) => {
      const u = 1 - t;
      return { x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x, y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y };
    };

    ctx.globalAlpha = reveal * 0.35;
    ctx.strokeStyle = signal;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, B.x, B.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of [A, B]) {
      ctx.globalAlpha = reveal;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 + 7 * ease(clamp(age / 600)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    const legs = [
      { start: 600, from: A, to: B, tag: talk.tags[0] },
      { start: 2400, from: B, to: A, tag: talk.tags[1] },
    ];
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (const leg of legs) {
      const t = clamp((age - leg.start) / 1600);
      if (t <= 0 || t >= 1) continue;
      const head = at(ease(t), leg.from, leg.to);
      // A short glowing trail behind the envelope.
      ctx.fillStyle = signal;
      for (let k = 6; k >= 0; k--) {
        const pt = at(ease(clamp(t - k * 0.025)), leg.from, leg.to);
        ctx.globalAlpha = (1 - k / 7) * 0.6;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.6 - k * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = signal;
      ctx.fillText(`:${leg.tag}`, head.x + 7, head.y - 7);
    }
    ctx.globalAlpha = 1;
  }

  function startTalk(time) {
    if (talks.length >= 2) return;
    const lit = talks.flatMap((t) => [position(stars[t.a]), position(stars[t.b])]);
    const roomy = (s) => lit.every((p) => Math.hypot(p.x - position(s).x, p.y - position(s).y) > 110);
    const free = stars.map((s, i) => ({ s, i })).filter(({ s, i }) => s.agent >= 0 && clear(s) && roomy(s) && !talks.some((t) => t.a === i || t.b === i));
    if (free.length < 2) return;
    const a = free[Math.floor(Math.random() * free.length)];
    const others = free.filter((f) => f.i !== a.i);
    const b = others[Math.floor(Math.random() * others.length)];
    talks.push({ a: a.i, b: b.i, born: time, tags: EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)] });
  }

  function paint(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const half = REACH * scale;
    ctx.translate(cx, cy);
    ctx.scale(1, TILT);
    ctx.rotate(rotation);
    ctx.drawImage(disc, -half, -half, half * 2, half * 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLiveStars(time);
    for (const talk of talks) drawTalk(talk, time);
  }

  function frame(time) {
    if (!running) return;
    // Time-based, so the turn is equally slow at 60, 120 or 144 Hz.
    const dt = last === 0 ? 8 : Math.min(64, time - last);
    last = time;
    rotation += dt * 0.00005;
    if (time >= nextTalk) {
      startTalk(time);
      nextTalk = time + 1300 + Math.random() * 900;
    }
    talks = talks.filter((t) => time - t.born < TALK_MS);
    paint(time);
    requestAnimationFrame(frame);
  }

  function stillFrame() {
    rotation = 0.6;
    const agents = stars.map((s, i) => ({ s, i })).filter(({ s }) => s.agent >= 0 && clear(s));
    talks = [[0, 1], [2, 3]].flatMap(([x, y]) => (agents[x] && agents[y] ? [{ a: agents[x].i, b: agents[y].i, born: 0, tags: ["ask", "reply"] }] : []));
    paint(0);
  }

  build();
  resize();
  if (still) {
    stillFrame();
    window.addEventListener("resize", () => { resize(); stillFrame(); });
    return;
  }
  // Run only while the hero is on screen, the tab is visible, and nobody pressed stop.
  let visible = true;
  const start = () => { if (!running && !paused && visible && !document.hidden) { running = true; last = 0; requestAnimationFrame(frame); } };
  const stop = () => { running = false; };
  window.addEventListener("resize", () => { resize(); if (!running) paint(performance.now()); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  function setPaused(value) {
    paused = value;
    try { localStorage.setItem("galaxy-paused", value ? "1" : "0"); } catch (e) { /* storage may be blocked */ }
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(value));
      toggle.setAttribute("aria-label", value ? "Play the animation" : "Stop the animation");
      toggle.title = toggle.getAttribute("aria-label") ?? "";
    }
    value ? stop() : start();
  }
  let stored = null;
  try { stored = localStorage.getItem("galaxy-paused"); } catch (e) { /* storage may be blocked */ }
  toggle?.addEventListener("click", () => setPaused(!paused));
  setPaused(stored === "1");
  if (paused) paint(performance.now());
})();
