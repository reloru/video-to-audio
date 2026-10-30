import { describeAudio, describeVideo, formatBytes, formatDuration } from "../lib/describe";
import { audioStreams, codecLabel } from "../lib/plan";
import { CloseIcon, DownloadIcon, ShareIcon } from "./icons";
import type { AppStore, Item, Output } from "./store";
import { selectedStream } from "./store";

const FORMAT_NAMES = { m4a: "M4A", mp3: "MP3", wav: "WAV" } as const;

export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator.share === "function" && !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
}

export function shareFiles(files: File[]): void {
  navigator.share({ files }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    alert(`Sharing failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function OutputRow({ store, item, output }: { store: AppStore; item: Item; output: Output }) {
  const { plan } = output;
  const label = FORMAT_NAMES[plan.format];
  return (
    <li class={`output output--${output.status}`} data-format={plan.format} data-status={output.status} data-storage={output.storage}>
      <span class={`badge badge--${plan.kind}`}>{label}</span>
      <div class="output__body">
        <p class="output__summary">{plan.summary}</p>
        <p class="output__notes">
          {[
            output.track ? `Track ${output.track}` : null,
            ...plan.notes,
            output.status === "done" && output.file ? formatBytes(output.file.size) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {output.status === "running" && (
          <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(output.progress * 100)}>
            <div class="progress__bar" style={{ width: `${Math.max(2, output.progress * 100)}%` }} />
          </div>
        )}
        {output.status === "queued" && <p class="output__state">Waiting…</p>}
        {output.status === "canceled" && <p class="output__state">Canceled</p>}
        {output.status === "error" && (
          <details class="output__error">
            <summary>Failed: {output.error}</summary>
            {output.log && output.log.length > 0 && <pre>{output.log.join("\n")}</pre>}
          </details>
        )}
      </div>
      <div class="output__actions">
        {output.status === "done" && output.file && output.url && (
          <>
            {canShareFiles([output.file]) && (
              <button type="button" class="icon-button" aria-label={`Share ${label}`} onClick={() => shareFiles([output.file!])}>
                <ShareIcon />
              </button>
            )}
            <a class="icon-button" href={output.url} download={output.file.name} aria-label={`Save ${label}`}>
              <DownloadIcon />
            </a>
          </>
        )}
        {(output.status === "running" || output.status === "queued") && (
          <button type="button" class="text-button" onClick={() => store.cancel(item.id, output.id)}>
            Cancel
          </button>
        )}
        {(output.status === "error" || output.status === "canceled") && (
          <button type="button" class="text-button" onClick={() => store.retry(item.id, output.id)}>
            Retry
          </button>
        )}
      </div>
    </li>
  );
}

export function ItemCard({ store, item }: { store: AppStore; item: Item }) {
  const info = item.info;
  const streams = info ? audioStreams(info) : [];
  const stream = selectedStream(item);
  const video = info ? describeVideo(info) : null;
  const meta = [formatBytes(item.file.size), formatDuration(info?.duration), video].filter(Boolean).join(" · ");

  return (
    <article class="card item" data-status={item.status}>
      <header class="item__header">
        <div class="item__title">
          <h3 title={item.file.name}>{item.file.name}</h3>
          <p class="item__meta">{meta}</p>
        </div>
        <button type="button" class="icon-button icon-button--quiet" aria-label={`Remove ${item.file.name}`} onClick={() => store.remove(item.id)}>
          <CloseIcon />
        </button>
      </header>

      {item.status === "probing" && <p class="item__message">Reading file…</p>}
      {item.status === "noaudio" && <p class="item__message item__message--warn">This video has no audio track, so there is nothing to extract.</p>}
      {item.status === "unsupported" && (
        <p class="item__message item__message--warn">
          The audio is {streams.map((s) => codecLabel(s)).join(", ")}, which this app can't decode.
        </p>
      )}
      {item.status === "error" && <p class="item__message item__message--warn">Couldn't read this file: {item.error}</p>}

      {item.status === "ready" && stream && (
        <>
          {streams.length > 1 ? (
            <label class="item__track">
              <span>Audio track</span>
              <select value={String(stream.index)} onChange={(e) => store.setStream(item.id, Number((e.target as HTMLSelectElement).value))}>
                {streams.map((s, n) => (
                  <option value={String(s.index)} key={s.index} disabled={!s.decodable}>
                    {n + 1}: {describeAudio(s)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p class="item__audio">Audio: {describeAudio(stream)}</p>
          )}
          <ul class="outputs">
            {item.outputs
              .filter((o) => o.streamIndex === stream.index || (o.status !== "error" && o.status !== "canceled"))
              .map((output) => (
                <OutputRow key={output.id} store={store} item={item} output={output} />
              ))}
          </ul>
        </>
      )}
    </article>
  );
}
