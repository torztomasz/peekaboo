// Synthetic screenshots, drawn in the page so every run and every machine gets the same pixels: a seeded
// "web page" (header, centred column of text lines and cards) that a crop or a second window width of the
// same page can be cut from, like the pairs reviewers actually upload.
window.screens = (() => {
  function rng(seed) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  // `columnX` is where the content column starts: two window widths of one page differ only there.
  // `density` draws the same page for a retina screen (2 = twice the pixels each way).
  function page(width, height, { seed = 1, columnX = Math.max(0, (width - 1100) / 2), change = false, density = 1 } = {}) {
    const canvas = new OffscreenCanvas(width * density, height * density);
    const g = canvas.getContext("2d");
    g.scale(density, density);
    const random = rng(seed);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.fillStyle = "#24292f";
    g.fillRect(0, 0, width, 64);
    for (let y = 96; y < height - 40; ) {
      if (random() < 0.15) {
        const h = 80 + Math.floor(random() * 160);
        g.fillStyle = `hsl(${Math.floor(random() * 360)} 60% 85%)`;
        g.fillRect(columnX + 20, y, 1060, h);
        g.fillStyle = "#0969da";
        g.fillRect(columnX + 40, y + 20, 120 + Math.floor(random() * 200), 28);
        y += h + 24;
      } else {
        g.fillStyle = "#1f2328";
        let x = columnX + 20;
        while (x < columnX + 1000) {
          const word = 20 + Math.floor(random() * 70);
          g.fillRect(x, y, word, 10);
          x += word + 8;
        }
        y += 22;
      }
    }
    // Pinned to the window's right edge, so two window widths of a page differ beyond a crop.
    g.fillStyle = "#eaeef2";
    g.fillRect(width - 280, 64, 260, height - 64);
    if (change) {
      g.fillStyle = "#1a7f37";
      g.fillRect(columnX + 400, 300, 180, 36);
    }
    return canvas;
  }

  function crop(source, x, y, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(source, x, y, width, height, 0, 0, width, height);
    return canvas;
  }

  const url = async (canvas) => URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));

  // What the extension meets in pull requests, by message type. `expect` is the placement Auto should find.
  async function scenarios() {
    const screen = page(2560, 1600);
    const full = page(1280, 6000, { seed: 2, columnX: 90 });
    const tall = page(1280, 9000, { seed: 4, columnX: 90 });
    return {
      "compare 2560×1600 (one button changed)": {
        type: "compare", before: await url(screen), after: await url(page(2560, 1600, { change: true })),
      },
      "align viewport crop of a 1280×6000 full page": {
        type: "align", before: await url(full), after: await url(crop(full, 0, 2400, 1280, 800)),
        expect: { beforeX: 0, beforeY: 0, afterX: 0, afterY: 2400 },
      },
      "align viewport crop below row 4000 of a 1280×9000 full page": {
        type: "align", before: await url(tall), after: await url(crop(tall, 0, 6200, 1280, 800)),
        expect: { beforeX: 0, beforeY: 0, afterX: 0, afterY: 6200 },
      },
      "align 600×400 detail inside a 2560×1600 screen": {
        type: "align", before: await url(crop(screen, 913, 517, 600, 400)), after: await url(screen),
        expect: { beforeX: 913, beforeY: 517, afterX: 0, afterY: 0 },
      },
      "compare 2x vs 1x captures of one 1280×800 screen (one button changed)": {
        type: "compare", before: await url(page(1280, 800, { density: 2 })), after: await url(page(1280, 800, { change: true })),
      },
      "align 1200 vs 1600 window widths, one button changed": {
        type: "align", before: await url(page(1600, 1400, { seed: 3, columnX: 250 })), after: await url(page(1200, 1400, { seed: 3, columnX: 50, change: true })),
        expect: { beforeX: 0, beforeY: 0, afterX: 200, afterY: 0 },
      },
      "align 1200 vs 1600 window widths": {
        type: "align", before: await url(page(1600, 1400, { seed: 3, columnX: 250 })), after: await url(page(1200, 1400, { seed: 3, columnX: 50 })),
        expect: { beforeX: 0, beforeY: 0, afterX: 200, afterY: 0 },
      },
    };
  }

  return { page, crop, url, scenarios };
})();
