// A stand-in for a GitHub PR conversation, shared by the content-script tests and benchmark: a long
// timeline of ordinary comments (the DOM GitHub keeps mutating) with Before/After tables in some of them,
// rendered the way GitHub renders markdown tables. Images are inline SVGs with a natural size, so the
// widgets lay out without a network.
import { bundle, launch } from "./browser.mjs";

const image = (width, height, fill) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${fill}"/><rect x="40" y="40" width="120" height="30" fill="#000"/></svg>`)}`;

export const pairTable = (fill = "#cde") => `
  <markdown-accessiblity-table><table>
    <thead><tr><th>Before</th><th>After</th></tr></thead>
    <tbody><tr><td><img src="${image(400, 300, "#fff")}"></td><td><img src="${image(400, 300, fill)}"></td></tr></tbody>
  </table></markdown-accessiblity-table>
  <p><em>What this pair fixes</em></p>`;

const comment = (index, body) => `
  <div class="timeline-item" id="item-${index}">
    <div class="header"><a href="#">user${index}</a> commented <relative-time>${index} minutes ago</relative-time></div>
    <div class="markdown-body">${body}</div>
    <div class="reactions"><button>👍 <span>${index % 5}</span></button></div>
  </div>`;

const prose = (index) =>
  Array.from({ length: 6 }, (_, p) => `<p>Paragraph ${p} of comment ${index} with <code>code</code> and <a href="#">a link</a>.</p>`).join("");

// `comments` ordinary comments, every `every`-th one also carrying a Before/After table, plus one plain
// table that must be left alone.
export function conversation({ comments = 300, every = 50 } = {}) {
  const items = Array.from({ length: comments }, (_, index) => comment(index, prose(index) + (index % every === every - 1 ? pairTable() : "")));
  items.push(comment(comments, "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>"));
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div class="timeline">${items.join("")}</div></body></html>`;
}

// Loads `html`, then the content script built from `entry` (default: this checkout's), the way Chrome
// injects it at document_end. `before` runs first in the page, e.g. to wrap DOM APIs for counting.
export async function openConversation(html, { entry = new URL("../src/content.ts", import.meta.url).pathname, before } = {}) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent(html);
  if (before) await page.evaluate(before);
  await page.addScriptTag({ content: await bundle(entry) });
  await settle(page);
  return { browser, page };
}

// Two frames: the content script syncs on the frame after a mutation.
export const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
