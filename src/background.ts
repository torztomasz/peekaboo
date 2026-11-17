// Auto-align runs here because only the extension's own worker may read GitHub's uploaded images: they are
// served without CORS headers, so page code (and the userscript) can't get at their pixels. The permission
// for the image host is optional, asked for on the options page the first time someone picks Auto.
// This file fetches, decodes and encodes; the pixel work itself is in pixels.ts.

import { IMAGE_ORIGINS } from "./origins";
import { anyChange, densityOverlay, diffOverlay, findPlacement, isDark, type Image, type Overlay, type Placement } from "./pixels";

type PairRequest = { type: "align" | "compare"; before: string; after: string };
// `same`: no pixel differs visibly (by the rule that colours the diff), so the same screenshot was likely
// uploaded twice. Null where the two don't line up pixel for pixel (see `exact` in pixels.ts).
// `dark`: the screenshots are mostly dark (a dark theme), where content is the light part. The diff's colours
// are swapped for them, so red always marks what was removed and green what was added.
type AlignResponse = { placement: Placement; diff: string; same: boolean | null; dark: boolean } | { needsPermission: true } | { error: string };
type CompareResponse = { same: boolean; dark: boolean; diff?: string } | { needsPermission: true } | { error: string };

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "align" || message?.type === "compare") {
    answer(message as PairRequest).then(reply, (error) => reply({ error: String(error) }));
    return true;
  }
  if (message?.type === "open-options") openSettings(_sender.tab);
  return false;
});

// Onboarding: a welcome tab on first install, and the toolbar icon opens the same page, since that is
// where people look for an extension's settings.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome") });
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// From a pull request: next to it, about that one step, so the page can send the reviewer back.
function openSettings(tab?: chrome.tabs.Tab) {
  if (tab?.id == null) { chrome.runtime.openOptionsPage(); return; }
  chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?from=${tab.id}`), index: tab.index + 1, openerTabId: tab.id });
}

// GitHub re-renders a comment on edits and previews, which rebuilds its widgets and asks again about the
// same two images; an answer already worked out (or in progress) is reused instead of fetched, decoded and
// compared again. Reuse comes after the permission check, so revoking Auto takes effect at once. Only
// uploaded attachments keep their answer once done: their bytes never change behind the URL, while an
// image from a branch (raw.githubusercontent.com) can be pushed over, so it's shared only while in progress.
const answers = new Map<string, Promise<AlignResponse | CompareResponse>>();
const ANSWERS_KEPT = 50;

async function answer(request: PairRequest): Promise<AlignResponse | CompareResponse> {
  if (!(await hasImagePermission())) return { needsPermission: true };
  const key = JSON.stringify([request.type, request.before, request.after]);
  let work = answers.get(key);
  if (!work) {
    work = oneAtATime<AlignResponse | CompareResponse>(() => (request.type === "align" ? align(request) : compare(request)));
    answers.set(key, work);
    // Only this job's entry: by the time it ends, the cap may have evicted it and a retry taken its place.
    const forget = () => answers.get(key) === work && answers.delete(key);
    const keep = isAttachment(request.before) && isAttachment(request.after);
    work.then(() => keep || forget(), forget);
    if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
  }
  return work;
}

async function align({ before, after }: PairRequest): Promise<AlignResponse> {
  const [b, a] = await loadBoth(before, after);
  const { placement, exact } = findPlacement(b, a);
  const dark = isDark(b, a);
  const overlay = diffOverlay(b, a, placement, dark);
  return { placement, diff: await toDataUrl(overlay), same: exact ? overlay.changed === 0 : null, dark };
}

// Same-size pairs line up as they are, so the page only needs to know whether anything changed. It's the
// cheap way to catch the same screenshot uploaded twice, which Diff would show as a reassuring blank.
// Pairs at two pixel densities also get the diff itself: the page's compositor Diff can't tell resampling
// from change (see densityOverlay). They're compared at the smaller width, as the page shows them.
async function compare({ before, after }: PairRequest): Promise<CompareResponse> {
  const [b, a] = await loadBoth(before, after);
  const dark = isDark(b, a);
  if (b.width === a.width && b.height === a.height) return { same: !anyChange(b, a), dark };
  const width = Math.min(b.width, a.width);
  const overlay = densityOverlay(resample(b, width), resample(a, width), dark);
  return { same: overlay.changed === 0, dark, diff: await toDataUrl(overlay) };
}

function resample(image: Image, width: number): Image {
  if (image.width === width) return image;
  const height = Math.round((image.height * width) / image.width);
  const source = new OffscreenCanvas(image.width, image.height);
  source.getContext("2d")!.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true })!;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

const hasImagePermission = () => chrome.permissions.contains({ origins: IMAGE_ORIGINS });
const isAttachment = (url: string) => IMAGE_ORIGINS.some((origin) => url.startsWith(origin.slice(0, -1)));

// A PR with many pairs asks for all of them as it opens. The work is CPU-bound on one thread either way,
// so taking pairs one by one costs no total time, answers the first pair first instead of all near the
// end, and holds one pair's decoded screenshots in memory instead of every pair's.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

// Both settle before the queue moves on, so a failed load doesn't leave its sibling decoding beside the next pair.
async function loadBoth(before: string, after: string) {
  const [b, a] = await Promise.allSettled([load(before), load(after)]);
  if (b.status === "rejected") throw b.reason;
  if (a.status === "rejected") throw a.reason;
  return [b.value, a.value];
}

// Decoded once into RGBA, on a canvas kept in CPU memory (willReadFrequently) so reading it back is a copy.
async function load(url: string): Promise<Image> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

// An SVG the size of the whole canvas, holding a PNG of just the box that changed, so the page stretches it
// exactly like a full-canvas PNG but decodes only the changed part (nothing at all when nothing changed).
// Base64 needs no escaping inside a data: URL; only the SVG markup around it does.
async function toDataUrl({ width, height, box, data }: Overlay) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`, close = "</svg>";
  if (!box.width || !box.height) return `data:image/svg+xml,${encodeURIComponent(open + close)}`;
  const canvas = new OffscreenCanvas(box.width, box.height);
  canvas.getContext("2d")!.putImageData(new ImageData(data, box.width, box.height), 0, 0);
  const png = base64(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
  const image = `<image x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" href="data:image/png;base64,`;
  return `data:image/svg+xml,${encodeURIComponent(open + image)}${png}${encodeURIComponent(`"/>${close}`)}`;
}

function base64(bytes: Uint8Array) {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
