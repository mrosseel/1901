import { useState } from "react";
import { copyText } from "../clipboard";
import { QrImage } from "./QrImage";

/*
One shareable link: the address in full, a copy button, and its QR beside it.
The address is shown in full on purpose — at a table, people read it out or
type it as often as they scan it.

Except when the screen is not private. A game master's screen is often the
one plugged into the beamer, and every link here is a credential: an invite
takes a seat, a handover takes a power or the game itself. So a link may be
marked `private`, and then nothing is drawn until somebody asks for it. The
copy button still works with the link hidden, which is the common case — you
are sending it to one person, not showing it to a room.
*/
export function LinkShare({
  title,
  url,
  note,
  qr = true,
  private: guarded = false,
}: {
  title: string;
  url: string;
  note?: React.ReactNode;
  qr?: boolean;
  /* Hide the address and the code until asked, for a screen a room can see. */
  private?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [shown, setShown] = useState(!guarded);
  const [showQr, setShowQr] = useState(!guarded && qr);

  const copy = async () => {
    setCopied((await copyText(url)) ? "Copied" : "Copy failed — select the link");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="share">
      <h2>{title}</h2>
      <div className="share-body">
        <div className="share-text">
          {shown ? (
            <a className="share-url" href={url}>
              {url}
            </a>
          ) : (
            <p className="share-hidden">Don't show on a shared display!</p>
          )}
          <div className="share-actions">
            <button type="button" onClick={copy}>
              {copied || "Copy link"}
            </button>
            {guarded ? (
              <button type="button" className="link" onClick={() => setShown(!shown)}>
                {shown ? "Hide link" : "Show link"}
              </button>
            ) : null}
            {qr && guarded ? (
              <button type="button" className="link" onClick={() => setShowQr(!showQr)}>
                {showQr ? "Hide QR" : "Show QR"}
              </button>
            ) : null}
          </div>
          {note ? <p className="note">{note}</p> : null}
        </div>
        {qr && showQr ? (
          <div className="qr-box">
            <QrImage text={url} label={title + " QR code"} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
