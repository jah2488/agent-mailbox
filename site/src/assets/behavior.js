/* sitekit behavior.js — frozen. Vanilla, no dependencies, progressive enhancement.
   Modules: theme tri-switch, scroll-spy TOC, back-to-top, rail splitter,
   copy buttons, data mounts, timestamp. Rendering of fetched data stays with
   the page (spa-data-loading patterns); this file only manages mount state. */
(function () {
  "use strict";

  var LS = {
    theme: "sk-theme",
    rail: "sk-rail-w"
  };

  /* ---- theme: day / night / glitter, persisted, prefers-color-scheme first ---- */

  var THEMES = ["day", "night", "glitter"];

  function setTheme(value, persist) {
    // Guard here, not only at the init call site: a typo'd data-sk-theme on an
    // authored page must be ignored, not silently restyle the root to :root tokens.
    if (THEMES.indexOf(value) === -1) return;
    document.documentElement.setAttribute("data-theme", value);
    document.querySelectorAll(".sk-sparkle").forEach(function (particle) { particle.remove(); });
    if (persist) { try { localStorage.setItem(LS.theme, value); } catch (e) {} }
    document.querySelectorAll("[data-sk-theme]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-sk-theme") === value));
    });
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(LS.theme); } catch (e) {}
    var initial = THEMES.indexOf(stored) !== -1
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day");
    setTheme(initial, false);
    document.querySelectorAll("[data-sk-theme]").forEach(function (b) {
      var name = b.getAttribute("data-sk-theme");
      b.setAttribute("aria-label", name.charAt(0).toUpperCase() + name.slice(1));
      b.setAttribute("title", b.getAttribute("aria-label"));
      b.textContent = { day: "☀️", night: "🌙", glitter: "✨" }[name];
      b.addEventListener("click", function () { setTheme(b.getAttribute("data-sk-theme"), true); });
    });
    var lastSparkle = 0;
    var sparkleCount = 0;
    document.addEventListener("pointermove", function (event) {
      if (document.documentElement.dataset.theme !== "glitter" || event.pointerType === "touch" ||
          matchMedia("(prefers-reduced-motion: reduce)").matches || event.timeStamp - lastSparkle < 40) return;
      lastSparkle = event.timeStamp;
      var particle = document.createElement("span");
      particle.className = "sk-sparkle";
      particle.setAttribute("aria-hidden", "true");
      particle.textContent = sparkleCount++ % 2 ? "◆" : "✦";
      particle.style.left = event.clientX + "px";
      particle.style.top = event.clientY + "px";
      particle.style.setProperty("--sparkle-hue", (sparkleCount * 47 % 360) + "deg");
      document.body.appendChild(particle);
      setTimeout(function () { particle.remove(); }, 700);
    }, { passive: true });
  }

  /* ---- TOC: build from main h2/h3, scroll-spy via IntersectionObserver ---- */

  function slugify(text) {
    var s = text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
    var base = s || "section", n = 1;
    while (document.getElementById(s || base)) s = base + "-" + n++;
    return s || base;
  }

  function initToc() {
    var nav = document.querySelector(".sk-toc-nav");
    if (!nav) return;
    var main = document.querySelector(".sk-main") || document.body;
    var heads = main.querySelectorAll("h2, h3");
    heads.forEach(function (h) {
      if (!h.id) h.id = slugify(h.textContent);
      h.tabIndex = -1;
      var a = document.createElement("a");
      a.href = "#" + encodeURIComponent(h.id);
      a.textContent = h.textContent;
      a.setAttribute("data-sk-level", h.tagName === "H3" ? "3" : "2");
      nav.appendChild(a);
    });
    if (nav.children.length === 0) return;
    var links = Array.prototype.slice.call(nav.children);
    // Retain the current section through long paragraphs between headings.
    function update() {
      var header = document.querySelector('.sk-header');
      var threshold = (header ? header.getBoundingClientRect().height : 0) + 40;
      var current = heads[0];
      heads.forEach(function (h) { if (h.getBoundingClientRect().top <= threshold) current = h; });
      if (window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2) {
        current = heads[heads.length - 1];
      }
      links.forEach(function (a) {
        var active = a.hash === '#' + encodeURIComponent(current.id);
        a.classList.toggle('sk-active', active);
        if (active) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    }
    var scheduled = false;
    window.addEventListener('scroll', function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { update(); scheduled = false; });
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  function initContents() {
    var rail = document.querySelector('.sk-rail');
    var toggle = document.querySelector('[data-sk-contents]');
    var header = document.querySelector('.sk-header');
    if (header && 'ResizeObserver' in window) {
      new ResizeObserver(function () {
        document.documentElement.style.setProperty('--sk-header-h', header.getBoundingClientRect().height + 'px');
      }).observe(header);
    }
    if (!rail || !toggle) return;
    var mobile = window.matchMedia('(max-width: 860px)');
    var desktopOpen = true;
    try { desktopOpen = localStorage.getItem('sk-contents') !== 'closed'; } catch (e) {}
    function setOpen(open) {
      toggle.setAttribute('aria-expanded', String(open));
      rail.hidden = !open;
      document.documentElement.classList.toggle('sk-contents-closed', !open);
    }
    setOpen(mobile.matches ? false : desktopOpen);
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
      if (!mobile.matches) {
        desktopOpen = open;
        try { localStorage.setItem('sk-contents', open ? 'open' : 'closed'); } catch (e) {}
      }
    });
    mobile.addEventListener('change', function () { setOpen(mobile.matches ? false : desktopOpen); });
    rail.addEventListener('click', function (event) {
      var link = event.target.closest('.sk-toc-nav a');
      if (!link) return;
      var target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (mobile.matches) setOpen(false);
      if (target) target.focus({ preventScroll: true });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && mobile.matches && !rail.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  function initTables(root) {
    root.querySelectorAll('table[data-sk-sort]').forEach(function (table) {
      if (table.dataset.skSortedReady) return;
      table.dataset.skSortedReady = 'true';
      var body = table.tBodies[0];
      if (!body) return;
      table.querySelectorAll('thead th[data-sort]').forEach(function (th) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = th.textContent;
        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.className = 'sk-sort-icon';
        icon.textContent = '↕';
        button.appendChild(icon);
        th.replaceChildren(button);
        button.addEventListener('click', function () {
          var descending = th.getAttribute('aria-sort') === 'ascending';
          var numeric = th.dataset.sort === 'number';
          var rows = Array.from(body.rows);
          function value(row) {
            var cell = row.cells[th.cellIndex];
            var raw = (cell.dataset.value === undefined ? cell.textContent : cell.dataset.value).trim();
            return numeric ? (raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw)) : raw;
          }
          rows.sort(function (a, b) {
            var av = value(a), bv = value(b);
            if (av === null) return bv === null ? 0 : 1;
            if (bv === null) return -1;
            var order = numeric ? av - bv : av.localeCompare(bv, 'en', { numeric: true });
            return descending ? -order : order;
          });
          rows.forEach(function (row) { body.appendChild(row); });
          table.querySelectorAll('th[aria-sort]').forEach(function (header) { header.removeAttribute('aria-sort'); });
          table.querySelectorAll('.sk-sort-icon').forEach(function (mark) { mark.textContent = '↕'; });
          th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
          icon.textContent = descending ? '↓' : '↑';
        });
      });
    });
  }

  /* ---- back-to-top: visibility threshold ---- */

  function initTop() {
    var btn = document.querySelector(".sk-top-btn");
    if (!btn) return;
    var update = function () {
      btn.hidden = window.scrollY <= 600;
      btn.classList.toggle("sk-visible", window.scrollY > 600);
    };
    window.addEventListener("scroll", update, { passive: true });
    btn.addEventListener("click", function () {
      var main = document.querySelector('.sk-main');
      if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }); }
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    update();
  }

  /* ---- rail splitter: pointer events, width persisted ---- */

  function initSplitter() {
    var splitter = document.querySelector(".sk-splitter");
    var rail = document.querySelector(".sk-rail");
    if (!splitter || !rail) return;
    var MIN = 200, MAX = 420;
    try {
      var w = parseInt(localStorage.getItem(LS.rail), 10);
      if (w >= MIN && w <= MAX) applyRail(rail, w);
    } catch (e) {}
    function applyRail(rail, w) {
      document.documentElement.style.setProperty("--sk-rail-w", w + "px");
      splitter.setAttribute('aria-valuenow', String(w));
    }
    var dragging = false;
    var dragOrigin = { x: 0, width: 0 };
    splitter.addEventListener("pointerdown", function (e) {
      dragging = true;
      dragOrigin = { x: e.clientX, width: rail.getBoundingClientRect().width };
      splitter.classList.add("sk-dragging");
      splitter.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    splitter.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var w = Math.min(MAX, Math.max(MIN, dragOrigin.width + e.clientX - dragOrigin.x));
      applyRail(rail, w);
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("sk-dragging");
      try { localStorage.setItem(LS.rail, splitter.getAttribute('aria-valuenow')); } catch (e) {}
    };
    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);
    splitter.addEventListener('keydown', function (event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      var current = rail.getBoundingClientRect().width;
      var width = event.key === 'Home' ? MIN : event.key === 'End' ? MAX : current + (event.key === 'ArrowLeft' ? -16 : 16);
      applyRail(rail, Math.min(MAX, Math.max(MIN, width)));
      try { localStorage.setItem(LS.rail, splitter.getAttribute('aria-valuenow')); } catch (e) {}
    });
    splitter.addEventListener("dblclick", function () {
      try { localStorage.removeItem(LS.rail); } catch (e) {}
      document.documentElement.style.removeProperty("--sk-rail-w");
      splitter.setAttribute('aria-valuenow', String(Math.round(rail.getBoundingClientRect().width)));
    });
  }

  /* ---- copy buttons on code blocks ---- */

  function initCopy() {
    document.querySelectorAll(".sk-code").forEach(function (pre) {
      var text = pre.innerText; // captured before the button joins the DOM
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sk-copy-btn";
      btn.textContent = "copy";
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        Promise.resolve().then(function () { return navigator.clipboard.writeText(text); }).then(function () {
          btn.textContent = "copied";
          btn.setAttribute("aria-pressed", "true");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.setAttribute("aria-pressed", "false");
          }, 1500);
        }).catch(function () { btn.textContent = 'Select text to copy'; });
      });
      pre.appendChild(btn);
    });
  }

  /* ---- data mounts: fetch + state machine; rendering belongs to the page ----
     <div class="sk-mount" data-source="/api/thing">
       <div class="sk-skeleton" aria-hidden="true"></div>
     </div>
     Page renders via window.skRender(mountEl, data) or an sk:data listener. */

  function loadMount(el) {
    var url = el.getAttribute("data-source");
    el.setAttribute("aria-busy", "true");
    el.querySelectorAll(".sk-error").forEach(function (n) { n.remove(); });
    el.querySelectorAll(".sk-mount-body").forEach(function (n) { n.remove(); });
    fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      el.setAttribute("aria-busy", "false");
      if (typeof window.skRender === "function") {
        window.skRender(el, data);
      } else {
        var body = document.createElement("div");
        body.className = "sk-mount-body";
        body.textContent = JSON.stringify(data);
        el.appendChild(body);
      }
      el.dispatchEvent(new CustomEvent("sk:data", { bubbles: true, detail: data }));
      initTables(el);
    }).catch(function (err) {
      el.setAttribute("aria-busy", "false");
      var box = document.createElement("div");
      box.className = "sk-error";
      box.setAttribute("role", "alert");
      box.textContent = "failed to load " + url + " (" + err.message + ") ";
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "sk-retry";
      retry.textContent = "retry";
      retry.addEventListener("click", function () { loadMount(el); });
      box.appendChild(retry);
      el.appendChild(box);
    });
  }

  function initMounts() {
    document.querySelectorAll("[data-source]").forEach(function (el) { loadMount(el); });
  }

  /* ---- generated-at timestamp ---- */

  function initTimestamp() {
    document.querySelectorAll("[data-sk-timestamp]").forEach(function (el) {
      var v = el.getAttribute("data-sk-timestamp");
      var d = v ? new Date(v) : new Date(document.lastModified);
      if (!isNaN(d)) el.textContent = "generated " + d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // One theme: the page is night-only so the galaxy blends into it. (Kit theme switching is unused here.)
    initToc();
    initContents();
    initTables(document);
    initTop();
    initSplitter();
    initCopy();
    initMounts();
    initTimestamp();
  });
})();
