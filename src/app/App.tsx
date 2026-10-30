import { useEffect, useRef, useState } from "preact/hooks";
import type { OutputFormat, Settings } from "../lib/types";
import { CheckIcon, ShareIcon, VideoIcon } from "./icons";
import { canShareFiles, ItemCard, shareFiles } from "./ItemCard";
import type { AppStore } from "./store";

const FORMATS: { id: OutputFormat; name: string; blurb: string }[] = [
  { id: "m4a", name: "M4A", blurb: "Exact copy of the audio. No quality loss, small file." },
  { id: "mp3", name: "MP3", blurb: "Plays everywhere. Re-encoded at 320 kbps, so slightly lossy." },
  { id: "wav", name: "WAV", blurb: "Uncompressed PCM for editing apps. Large file, no further loss." },
];

const WAV_DEPTHS: { id: Settings["wavDepth"]; label: string; hint: string }[] = [
  { id: "auto", label: "Auto (recommended)", hint: "24-bit for compressed audio, the original depth for lossless audio." },
  { id: "16", label: "16-bit", hint: "CD format, works with everything. Dithered when reducing depth." },
  { id: "24", label: "24-bit", hint: "Holds the decoded audio well below audibility." },
  { id: "32f", label: "32-bit float", hint: "The decoder's exact output, including peaks above 0 dBFS. Some older apps can't open it." },
];

const MP3_MODES: { id: Settings["mp3Mode"]; label: string; hint: string }[] = [
  { id: "cbr320", label: "320 kbps CBR (max)", hint: "Highest MP3 bitrate." },
  { id: "v0", label: "VBR V0", hint: "Transparent for nearly all listeners, usually smaller files." },
];

// The extensions help iOS offer files whose types it doesn't classify as video (MKV, WebM...).
const ACCEPT = "video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.avi,.ts,.mts,.m2ts,.3gp,.flv,.wmv";

export function App({ store }: { store: AppStore }) {
  const [, setVersion] = useState(0);
  useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), [store]);
  const input = useRef<HTMLInputElement>(null);

  const { settings, items } = store;
  const done = store.doneFiles;
  const pending = store.pendingWork;

  const onPick = (event: Event) => {
    const target = event.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    target.value = "";
    if (files.length) void store.addFiles(files);
  };

  return (
    <main class="app">
      <header class="hero">
        <h1>Video to Audio</h1>
        <p>Pulls the soundtrack out of videos as M4A, MP3 or WAV. Everything runs on this device; nothing is uploaded.</p>
      </header>

      <section class="card" aria-labelledby="formats-title">
        <h2 id="formats-title">Output</h2>
        <div class="formats" role="group" aria-label="Output formats">
          {FORMATS.map((f) => {
            const on = settings.formats.includes(f.id);
            return (
              <button
                type="button"
                key={f.id}
                class={`format ${on ? "format--on" : ""}`}
                aria-pressed={on}
                onClick={() => store.toggleFormat(f.id)}
              >
                <span class="format__name">
                  {on && <CheckIcon />}
                  {f.name}
                </span>
                <span class="format__blurb">{f.blurb}</span>
              </button>
            );
          })}
        </div>

        <details class="options">
          <summary>Quality options</summary>
          <fieldset>
            <legend>WAV bit depth</legend>
            {WAV_DEPTHS.map((d) => (
              <label class="radio" key={d.id}>
                <input type="radio" name="wavDepth" checked={settings.wavDepth === d.id} onChange={() => store.setSettings({ wavDepth: d.id })} />
                <span>
                  <strong>{d.label}</strong>
                  <small>{d.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>MP3 encoding</legend>
            {MP3_MODES.map((m) => (
              <label class="radio" key={m.id}>
                <input type="radio" name="mp3Mode" checked={settings.mp3Mode === m.id} onChange={() => store.setSettings({ mp3Mode: m.id })} />
                <span>
                  <strong>{m.label}</strong>
                  <small>{m.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </details>
      </section>

      <label class="pick">
        <input ref={input} type="file" accept={ACCEPT} multiple onChange={onPick} />
        <VideoIcon />
        <span>{items.length ? "Add more videos" : "Choose videos"}</span>
      </label>
      <p class="hint">Pick from Photos or Files. Files gives the browser the untouched original; iOS may hand over a re-packaged copy from Photos.</p>

      {pending > 0 && items.length > 0 && (
        <button type="button" class="secondary-button" onClick={() => store.convertMissing()}>
          Convert with current settings
        </button>
      )}

      {items.length > 0 && (
        <section class="items" aria-label="Files">
          {items.map((item) => (
            <ItemCard key={item.id} store={store} item={item} />
          ))}
        </section>
      )}

      {items.length > 0 && (
        <div class="bulk">
          {done.length > 1 && canShareFiles(done) && (
            <button type="button" class="primary-button" onClick={() => shareFiles(done)}>
              <ShareIcon /> Share all ({done.length})
            </button>
          )}
          <button type="button" class="text-button" onClick={() => store.clear()}>
            Clear list
          </button>
        </div>
      )}

      {store.busy && <p class="hint hint--center">Keep this page open while converting. The screen stays on until it's done.</p>}

      <details class="card about">
        <summary>How it works</summary>
        <ul>
          <li>
            <strong>Only the audio is touched.</strong> The video (HEVC, H.264, HDR10…) is never decoded, so its format doesn't matter.
          </li>
          <li>
            <strong>M4A</strong> copies the original AAC audio packets unchanged, keeping the timing that removes encoder padding. If the audio isn't AAC or ALAC, it's stored as Apple Lossless instead.
          </li>
          <li>
            <strong>WAV</strong> decodes the audio once, at the original sample rate and channel count, trimmed to the exact length the video declares.
          </li>
          <li>
            <strong>MP3</strong> is re-encoded with LAME. Sample rates MP3 players don't universally support (like 8 kHz) are resampled to 48 or 44.1 kHz, and surround is downmixed to stereo.
          </li>
          <li>
            <strong>Metadata is removed:</strong> titles, dates, locations, device and encoder tags. Only what players need remains (like the MP3 gapless header).
          </li>
          <li>
            Built with <a href="https://ffmpeg.org">FFmpeg</a> (LGPL 2.1) and <a href="https://lame.sourceforge.io">LAME</a> (LGPL 2) compiled to WebAssembly.{" "}
            <a href="https://github.com/reloru/video-to-audio">Source and build script</a>.
          </li>
        </ul>
      </details>
    </main>
  );
}
