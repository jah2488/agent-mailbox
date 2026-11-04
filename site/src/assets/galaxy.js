// @ts-check
// The hero: a slowly turning spiral galaxy. Now and then two of its stars
// reveal themselves as agents and an envelope arcs between them. Purely
// decorative (aria-hidden); with reduced motion it draws one still frame.
(() => {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector("[data-galaxy]"));
  if (!canvas) return;
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) return;
  const ctx = maybeCtx;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Fictional agents: a person's interactive Claude, or their daemon.
  const AGENTS = ["robin · claude", "robin · daemon", "ada · claude", "kai · daemon", "noor · claude", "sam · daemon", "lee · claude", "jo · daemon", "mira · claude", "theo · daemon", "ines · claude", "wren · daemon", "oto · claude", "pia · daemon"];
  const EXCHANGES = [["ask", "reply"], ["ask", "reply"], ["ask", "promise"], ["hello", "hello"], ["ask", "waiting for you"], ["promise", "fulfil"]];
  const PALETTE = ["#cfe0ff", "#ffffff", "#b9c8ff", "#c79bff", "#ff9bd6", "#8ff0ff", "#fff2c8"];

  const ARM_TWIST = 5.6;
  let width = 0, height = 0, cx = 0, cy = 0, scale = 1;
  /** @type {{r:number,a:number,s:number,c:string,tw:number,agent:number}[]} */
  let stars = [];
  /** @type {{a:number,b:number,born:number,tags:string[]}[]} */
  let talks = [];
  let rotation = 0;
  let last = 0;
  let nextTalk = 0;
  let running = false;

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
      stars.push({ r: 0.03 + r * 0.97, a, s: rand() < 0.05 ? 2.1 : 0.7 + rand() * 1.2, c: PALETTE[Math.floor(rand() * PALETTE.length)], tw: rand() * Math.PI * 2, agent: -1 });
    }
    // Agents live in the mid disc, where they are easy to see and never in the core's glare.
    const candidates = stars.map((s, i) => ({ s, i })).filter(({ s }) => s.r > 0.3 && s.r < 0.85 && s.s < 1.9);
    AGENTS.forEach((_, n) => {
      const pick = candidates[Math.floor((n + 0.5) * (candidates.length / AGENTS.length))];
      if (pick) pick.s.agent = n;
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const wide = width > 860;
    cx = wide ? width * 0.66 : width * 0.5;
    cy = wide ? height * 0.5 : height * 0.26;
    scale = Math.min(wide ? width * 0.4 : width * 0.62, height * (wide ? 0.78 : 0.42));
  }

  // The arms turn as one pattern (a density wave), so the spiral never winds itself up.
  function position(s) {
    const a = s.a + rotation;
    // Tilted disc: squash the vertical axis.
    return { x: cx + Math.cos(a) * s.r * scale, y: cy + Math.sin(a) * s.r * scale * 0.56 };
  }

  // Gas clouds sit along the arms, so the colour swirls with the stars.
  const ARM_COLORS = ["124,92,255", "255,86,168", "60,206,212"];
  const CLOUDS = [
    { r: 0.03, a: 0, size: 0.34, color: "255,220,170", alpha: 0.55 },
    { r: 0.03, a: 0, size: 0.75, color: "160,120,255", alpha: 0.16 },
    ...[0, 1, 2].flatMap((arm) =>
      [0.22, 0.42, 0.62, 0.84].map((r, k) => ({ r, a: arm * ((Math.PI * 2) / 3) + r * 5.6, size: 0.2 + r * 0.22, color: ARM_COLORS[(arm + k) % 3], alpha: 0.2 - r * 0.1 })),
    ),
  ];
  /** Only agents clear of the headline and copy light up, so labels never sit under text. */
  function clear(s) {
    const p = position(s);
    return width > 860 ? p.x > width * 0.52 && p.x < width - 150 : p.y > 24 && p.y < height * 0.34 && p.x < width - 120;
  }

  function drawNebula() {
    ctx.globalCompositeOperation = "lighter";
    for (const c of CLOUDS) {
      const a = c.a + rotation;
      const x = cx + Math.cos(a) * c.r * scale;
      const y = cy + Math.sin(a) * c.r * scale * 0.56;
      const g = ctx.createRadialGradient(x, y, 0, x, y, c.size * scale);
      g.addColorStop(0, `rgba(${c.color},${c.alpha})`);
      g.addColorStop(1, `rgba(${c.color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawStars(time) {
    for (const s of stars) {
      const { x, y } = position(s);
      if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue;
      const twinkle = still ? 0.8 : 0.55 + 0.45 * Math.sin(time * 0.0016 + s.tw);
      ctx.globalAlpha = Math.min(1, twinkle * (1.35 - s.r * 0.45));
      ctx.fillStyle = s.c;
      ctx.fillRect(x - s.s / 2, y - s.s / 2, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--galaxy-signal").trim() || "#8ff0ff";

  // One conversation: reveal (0-0.6s), envelope out (0.6-2.2s), answer back (2.4-4s), fade (4-5.2s).
  const TALK_MS = 5200;
  function drawTalk(talk, time, signal) {
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

    ctx.save();
    ctx.globalAlpha = reveal * 0.35;
    ctx.strokeStyle = signal;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, B.x, B.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    for (const [p, index] of [[A, talk.a], [B, talk.b]]) {
      const ring = 5 + 7 * ease(clamp(age / 600));
      ctx.globalAlpha = reveal;
      ctx.strokeStyle = signal;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(230,236,255,0.92)";
      ctx.fillText(AGENTS[stars[index].agent], p.x + ring + 5, p.y + 4);
    }

    const legs = [
      { start: 600, from: A, to: B, tag: talk.tags[0] },
      { start: 2400, from: B, to: A, tag: talk.tags[1] },
    ];
    for (const leg of legs) {
      const t = clamp((age - leg.start) / 1600);
      if (t <= 0 || t >= 1) continue;
      const head = at(ease(t), leg.from, leg.to);
      // A short glowing trail behind the envelope.
      for (let k = 6; k >= 0; k--) {
        const pt = at(ease(clamp(t - k * 0.025)), leg.from, leg.to);
        ctx.globalAlpha = (1 - k / 7) * 0.6;
        ctx.fillStyle = signal;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.6 - k * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = signal;
      ctx.fillText(`:${leg.tag}`, head.x + 7, head.y - 7);
    }
    ctx.globalAlpha = 1;
  }

  function startTalk(time) {
    if (talks.length >= 2) return;
    // Keep a lit agent's label from landing on another's.
    const lit = talks.flatMap((t) => [position(stars[t.a]), position(stars[t.b])]);
    const roomy = (s) => lit.every((p) => Math.hypot(p.x - position(s).x, p.y - position(s).y) > 150);
    const free = stars.map((s, i) => ({ s, i })).filter(({ s, i }) => s.agent >= 0 && clear(s) && roomy(s) && !talks.some((t) => t.a === i || t.b === i));
    if (free.length < 2) return;
    const a = free[Math.floor(Math.random() * free.length)];
    // Someone's Claude never mails their own daemon.
    const person = (f) => AGENTS[f.s.agent].split(" ")[0];
    const others = free.filter((f) => person(f) !== person(a));
    const b = others[Math.floor(Math.random() * others.length)];
    if (!b) return;
    talks.push({ a: a.i, b: b.i, born: time, tags: EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)] });
  }

  function frame(time) {
    if (!running) return;
    const dt = last === 0 ? 16 : Math.min(64, time - last);
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

  function paint(time) {
    ctx.clearRect(0, 0, width, height);
    drawNebula();
    drawStars(time);
    const signal = accent();
    for (const talk of talks) drawTalk(talk, time, signal);
  }

  function stillFrame() {
    rotation = 0.6;
    const agents = stars.map((s, i) => ({ s, i })).filter(({ s }) => s.agent >= 0 && clear(s));
    const pairs = [[0, 1], [2, 3], [4, 5]];
    talks = pairs.flatMap(([x, y]) => (agents[x] && agents[y] ? [{ a: agents[x].i, b: agents[y].i, born: 0, tags: ["ask", "reply"] }] : []));
    paint(0);
  }

  build();
  resize();
  if (still) {
    stillFrame();
    window.addEventListener("resize", () => { resize(); stillFrame(); });
    return;
  }
  window.addEventListener("resize", resize);
  // Run only while the hero is on screen and the tab is visible.
  const start = () => { if (!running) { running = true; last = 0; requestAnimationFrame(frame); } };
  const stop = () => { running = false; };
  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; visible && !document.hidden ? start() : stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden || !visible ? stop() : start()));
  start();
})();
