import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const fixture = (name: string) => join(FIXTURES, name);
const scratch = mkdtempSync(join(tmpdir(), "vta-e2e-"));

function ffprobe(path: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).toString());
}

function decodeMd5(path: string, stream = "0:a:0"): string {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-map", stream, "-f", "md5", "-"]).toString().trim();
}

async function selectFormats(page: Page, formats: ("M4A" | "MP3" | "WAV")[]) {
  // Turn wanted formats on before turning others off: the app always keeps one selected.
  const all = ["M4A", "MP3", "WAV"] as const;
  for (const name of [...all.filter((n) => formats.includes(n)), ...all.filter((n) => !formats.includes(n))]) {
    const button = page.getByRole("button", { name: new RegExp(`^${name}`) });
    const pressed = (await button.getAttribute("aria-pressed")) === "true";
    if (pressed !== formats.includes(name)) await button.click();
  }
  for (const name of all) {
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-pressed", String(formats.includes(name)));
  }
}

async function pick(page: Page, ...names: string[]) {
  await page.locator('input[type="file"]').setInputFiles(names.map((n) => (n.startsWith("/") ? n : fixture(n))));
}

async function save(page: Page, format: string, scope = page.locator(".item").first(), fileName?: string): Promise<string> {
  const rows = scope.locator(`.output[data-format="${format}"][data-status="done"]`);
  const link = fileName ? rows.locator(`a[download="${fileName}"]`) : rows.locator("a[download]");
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const path = join(scratch, `${test.info().project.name}-${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(path);
  return path;
}

async function convertScreenRecording(page: Page, expectedStorage: "opfs" | "memory") {
  await selectFormats(page, ["M4A", "MP3", "WAV"]);
  await pick(page, "hevc-aac.mov");

  const item = page.locator(".item");
  await expect(item).toContainText("HEVC · 64×128");
  await expect(item).toContainText("Audio: AAC · 44.1 kHz · stereo");

  const m4a = await save(page, "m4a");
  const mp3 = await save(page, "mp3");
  const wav = await save(page, "wav");
  expect(m4a.endsWith("hevc-aac.m4a")).toBe(true);
  await expect(item.locator(`.output[data-storage="${expectedStorage}"]`)).toHaveCount(3);

  const m4aInfo = ffprobe(m4a);
  expect(m4aInfo.format.tags.major_brand).toBe("M4A ");
  expect(m4aInfo.streams).toHaveLength(1);
  expect(m4aInfo.streams[0].codec_name).toBe("aac");
  expect(decodeMd5(m4a)).toBe(decodeMd5(fixture("hevc-aac.mov"), "0:1"));

  expect(ffprobe(mp3).streams[0]).toMatchObject({ codec_name: "mp3", sample_rate: "44100", bit_rate: "320000" });
  expect(ffprobe(wav).streams[0]).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "44100", channels: 2, duration_ts: 88200 });
}

test("converts an HEVC screen recording to M4A, MP3 and WAV, writing outputs to on-device storage", async ({ playwright, browserName }, testInfo) => {
  // A persistent profile behaves like normal (non-private) browsing.
  const { defaultBrowserType: _ignored, ...device } = testInfo.project.use as Record<string, unknown>;
  const context = await playwright[browserName].launchPersistentContext(join(scratch, `profile-${browserName}`), {
    ...device,
    baseURL: "http://localhost:4173",
    acceptDownloads: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await convertScreenRecording(page, "opfs");
  } finally {
    await context.close();
  }
});

test("keeps outputs in memory when asked to", async ({ page }) => {
  await page.goto("/?output=memory");
  await convertScreenRecording(page, "memory");
});

test("falls back to memory where on-device storage is unavailable, as in Safari private browsing", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Only WebKit disables the Origin Private File System in ephemeral sessions");
  await page.goto("/");
  await convertScreenRecording(page, "memory");
});

test("handles an HDR10 mp42 file with the audio as track 1", async ({ page }) => {
  await page.goto("/");
  await selectFormats(page, ["M4A"]);
  await pick(page, "hevc-hdr10-aac.mp4");
  await expect(page.locator(".item")).toContainText("HDR10");
  const m4a = await save(page, "m4a");
  expect(decodeMd5(m4a)).toBe(decodeMd5(fixture("hevc-hdr10-aac.mp4"), "0:0"));
});

test("explains when a video has no audio track", async ({ page }) => {
  await page.goto("/");
  await pick(page, "h264-noaudio.mp4", "hevc-noaudio.mov");
  await expect(page.locator(".item")).toHaveCount(2);
  await expect(page.getByText("This video has no audio track")).toHaveCount(2);
  await expect(page.locator(".output")).toHaveCount(0);
});

test("lets you pick among several audio tracks", async ({ page }) => {
  await page.goto("/");
  await selectFormats(page, ["WAV"]);
  await pick(page, "h264-two-audio.mp4");
  const item = page.locator(".item");
  const select = item.getByRole("combobox");
  await expect(select).toHaveValue("2");
  const first = await save(page, "wav", item, "h264-two-audio (track 2).wav");
  expect(ffprobe(first).streams[0]).toMatchObject({ channels: 2, sample_rate: "48000" });

  await select.selectOption("1");
  const second = await save(page, "wav", item, "h264-two-audio (track 1).wav");
  expect(ffprobe(second).streams[0]).toMatchObject({ channels: 1, sample_rate: "44100" });
  await expect(item.locator(".output")).toHaveCount(2);
});

test("cancels a running conversion and keeps working afterwards", async ({ page }) => {
  const long = join(scratch, "long.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.3:sample_rate=48000:duration=300",
    "-ac", "2", "-c:a", "aac", "-b:a", "96k", long,
  ]);
  await page.goto("/");
  await selectFormats(page, ["MP3"]);
  await pick(page, long);
  const running = page.locator('.output[data-status="running"]');
  await expect(running).toBeVisible();
  await running.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('.output[data-status="canceled"]')).toBeVisible();

  await pick(page, "h264-aac.m4v");
  await expect(page.locator(".item").nth(1).locator('.output[data-status="done"]')).toBeVisible();
});

/** Serves the production build on its own port so the test can take the "network" away for real. */
function serveDist(): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
  };
  const root = resolve(import.meta.dirname, "../../dist");
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

test("works offline after the first visit", async ({ playwright, browserName }, testInfo) => {
  const server = await serveDist();
  const { defaultBrowserType: _ignored, ...device } = testInfo.project.use as Record<string, unknown>;
  const context = await playwright[browserName].launchPersistentContext(join(scratch, `offline-${browserName}`), {
    ...device,
    acceptDownloads: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(server.url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await server.close();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Video to Audio" })).toBeVisible();
    await selectFormats(page, ["M4A"]);
    await pick(page, "hevc-aac.mov");
    await save(page, "m4a");
  } finally {
    await context.close();
    await server.close().catch(() => {});
  }
});
