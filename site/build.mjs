// Builds the agent-mailbox site into dist/. The authored pages live in
// src/pages; the relay spec page is rendered from the repo's docs/*.md, so the
// spec has one source and the site can't drift from it.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "..", "docs");
const out = join(here, "dist");
const REPO = "https://github.com/jah2488/agent-mailbox";

const PAGES = [
  { file: "index.html", nav: "Overview", title: "agent-mailbox", description: "Signed, encrypted mail between coworkers' AI agents. Ask a teammate's agent; it answers from a folder they chose, or waits for them.", scripts: ["galaxy.js", "seal.js"] },
  { file: "install.html", nav: "Install", title: "Install · agent-mailbox", description: "Install agent-mailbox in one command, connect with teammates, and turn on the daemon." },
  { file: "use.html", nav: "Use it", title: "Use it · agent-mailbox", description: "Ask a teammate's agent, read what arrives, keep promises, and let your daemon answer." },
  { file: "relay.html", nav: "Relay spec", title: "Relay spec · agent-mailbox", description: "The agent-mailbox/1 relay protocol, and how to run a conforming relay.", contents: true },
];

const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Markdown to the kit's markup. shift demotes headings (the page owns h1);
 * links to other docs become in-page anchors, and repo paths go to GitHub.
 */
function renderDoc(markdown, { shift, docFile, anchors }) {
  const captions = [];
  let lastHeading = "";
  const marked = new Marked({
    walkTokens(token) {
      if (token.type === "heading") lastHeading = token.text.replace(/`/g, "");
      if (token.type === "table") captions.push(lastHeading);
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const level = Math.min(depth + shift, 6);
        return `<h${level} id="${slug(html)}">${html}</h${level}>\n`;
      },
      code({ text, lang }) {
        return `<pre class="sk-code"${lang ? ` data-lang="${escape(lang)}"` : ""}><code>${escape(text)}</code></pre>\n`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        let target = href;
        if (anchors[href] !== undefined) target = anchors[href];
        else if (!/^[a-z]+:|^#/.test(href)) target = `${REPO}/blob/main/${posix.normalize(posix.join("docs", posix.dirname(docFile), href))}`;
        return `<a href="${escape(target)}">${text}</a>`;
      },
    },
  });
  let html = marked.parse(markdown);
  let index = 0;
  html = html.replace(/<table>/g, () => `<div class="sk-table-wrap" role="region" aria-label="${escape(captions[index] ?? "Table")}" tabindex="0"><table><caption>${escape(captions[index++] ?? "Table")}</caption>`);
  html = html.replace(/<\/table>/g, "</table></div>").replace(/<th>/g, '<th scope="col">');
  return html;
}

/** The H1 and the first paragraph of a doc become the section's lead; the rest renders below. */
function splitLead(markdown) {
  const [, title, rest] = /^# (.+)\n+([\s\S]*)$/.exec(markdown) ?? [];
  return { title, rest };
}

async function relayPage() {
  const anchors = { "relay-protocol.md": "#the-protocol", "run-a-relay.md": "#run-a-relay" };
  const protocol = splitLead(await readFile(join(docs, "relay-protocol.md"), "utf8"));
  const guide = splitLead(await readFile(join(docs, "run-a-relay.md"), "utf8"));
  return `
<header class="page-intro"><p class="sk-kicker">agent-mailbox/1</p><h1>Build a relay</h1>
<p class="sk-lead">A relay is the one server a team shares. It stores encrypted envelopes, checks their signatures and chains, and serves each envelope only to its sender and recipient. Below is the full protocol a relay must follow, then a guide to deploying the reference relay.</p>
<p class="source-note">Rendered from <a href="${REPO}/blob/main/docs/relay-protocol.md"><code>docs/relay-protocol.md</code></a> and <a href="${REPO}/blob/main/docs/run-a-relay.md"><code>docs/run-a-relay.md</code></a> in the repo.</p></header>
<section class="sk-section spec" aria-labelledby="the-protocol"><h2 id="the-protocol">The protocol</h2>
${renderDoc(protocol.rest, { shift: 1, docFile: "relay-protocol.md", anchors })}</section>
<section class="sk-section spec" aria-labelledby="run-a-relay"><h2 id="run-a-relay">Run a relay</h2>
${renderDoc(guide.rest, { shift: 1, docFile: "run-a-relay.md", anchors })}</section>`;
}

// Only the long spec page gets an "on this page" panel; the others are short enough to scroll.
const CONTENTS_BUTTON = `<button type="button" data-sk-contents aria-expanded="true" aria-controls="contents"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M8 3v14M11 7h4M11 10h4"/></svg>Contents</button>`;
const RAIL = `<nav class="sk-rail" id="contents" aria-label="On this page"><div class="sk-rail-inner"><p class="sk-toc-title">On this page</p><div class="sk-toc-nav"></div></div></nav>`;

const navFor = (current) =>
  PAGES.map((p) => `<a href="${p.file === "index.html" ? "./" : p.file}"${p.file === current ? ' aria-current="page"' : ""}>${p.nav}</a>`).join("");

const layout = await readFile(join(here, "src", "layout.html"), "utf8");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(here, "src", "assets"), out, { recursive: true });
for (const page of PAGES) {
  const content = page.file === "relay.html" ? await relayPage() : await readFile(join(here, "src", "pages", page.file), "utf8");
  const html = layout
    .replaceAll("{{title}}", escape(page.title))
    .replaceAll("{{description}}", escape(page.description))
    .replaceAll("{{nav}}", navFor(page.file))
    .replaceAll("{{page}}", page.file.replace(".html", ""))
    .replace("{{contents_button}}", page.contents ? CONTENTS_BUTTON : "")
    .replace("{{rail}}", page.contents ? RAIL : "")
    .replace("{{scripts}}", (page.scripts ?? []).map((src) => `<script src="${src}"></script>`).join(""))
    .replace("{{content}}", () => content);
  await writeFile(join(out, page.file), html);
}
console.log(`built ${PAGES.length} pages into dist/`);
