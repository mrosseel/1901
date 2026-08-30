/*
Copy text to the clipboard, on a page served over plain http.

`navigator.clipboard` exists only in a secure context, which means https or
localhost. A game master hands this app round on a LAN address, so the modern
API is missing exactly where the copy matters most and throwing there told the
user to select the link by hand.

The old path still works on those origins: put the text in a field, select it,
and let the document copy the selection. It needs a real element in the
document and a real selection, which is why the field is appended rather than
detached.
*/
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Falls through: a secure context can still refuse on a denied permission.
    }
  }

  const field = document.createElement("textarea");
  field.value = text;
  // Off screen rather than hidden: a field that cannot be focused cannot be
  // selected, and the copy reads the selection.
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "-1000px";
  field.style.opacity = "0";
  document.body.appendChild(field);

  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
