// A strategy or vault as an image to post: preview the card, then save it as PNG (for social sites) or SVG.

import { useEffect, useMemo, useRef, useState } from "react";
import { POSTER, posterSvg, type PosterInput } from "../../agent/poster";
import { LISTINGS } from "../../agent/listings";

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function save(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Rasterise at twice the card's size so it stays sharp on high-density screens and in previews. */
async function toPng(svg: string): Promise<Blob> {
  const img = new Image();
  img.src = svgUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = POSTER.width * 2;
  canvas.height = POSTER.height * 2;
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not draw the card."))), "image/png"));
}

export function ShareCardButton({ input, fileName, label = "Share card" }: { input: () => PosterInput; fileName: string; label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Built when opened, from the state at that moment.
  const [card, setCard] = useState<PosterInput | null>(null);
  const svg = useMemo(() => (card ? posterSvg(card, LISTINGS) : ""), [card]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return (
    <>
      <button
        className="btn small"
        title="An image of this to post or send: the allocation as light, the rules, and where to find it"
        onClick={() => {
          setError(null);
          setCard(input());
          setOpen(true);
        }}
      >
        {label}
      </button>
      <dialog ref={dialog} className="share-card" aria-label="Share card" onClose={() => setOpen(false)}>
        {open && card && (
          <>
            <img src={svgUrl(svg)} width={POSTER.width} height={POSTER.height} alt={`${card.title}: ${card.allocations.filter((a) => a.percent > 0).map((a) => `${a.symbol} ${Math.round(a.percent * 10) / 10}%`).join(", ")}. ${card.rules.join(". ")}.`} />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              {error && <span className="notice bad small">{error}</span>}
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    const url = URL.createObjectURL(await toPng(svg));
                    save(url, `${fileName}.png`);
                    setTimeout(() => URL.revokeObjectURL(url), 10_000);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Download PNG
              </button>
              <button className="btn" onClick={() => save(svgUrl(svg), `${fileName}.svg`)}>
                Download SVG
              </button>
              <button className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
