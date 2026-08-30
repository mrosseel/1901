import { useState } from "react";
import { copyText } from "../clipboard";
import { QrImage } from "./QrImage";

/*
One shareable link: the address in full, a copy button, and its QR beside it.
The address is shown in full on purpose — at a table, people read it out or
type it as often as they scan it.
*/
export function LinkShare({
  title,
  url,
  note,
  qr = true,
}: {
  title: string;
  url: string;
  note?: React.ReactNode;
  qr?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async () => {
    setCopied((await copyText(url)) ? "Copied" : "Copy failed — select the link");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="share">
      <h2>{title}</h2>
      <div className="share-body">
        <div className="share-text">
          <a className="share-url" href={url}>
            {url}
          </a>
          <div className="share-actions">
            <button type="button" onClick={copy}>
              {copied || "Copy link"}
            </button>
          </div>
          {note ? <p className="note">{note}</p> : null}
        </div>
        {qr ? (
          <div className="qr-box">
            <QrImage text={url} label={title + " QR code"} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
