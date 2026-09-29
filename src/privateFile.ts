// Booking documents (guest ID proofs, Hotel/Event/Spa booking attachments) are
// stored encrypted and open only through a signed-in route that checks the
// booking's permission and logs the view, so a plain <a href>, <img src> or
// <iframe src> cannot load them. These fetch the file with the token and give
// the browser a blob: URL instead.
import { translate, getAppLanguage } from './i18n';

/** A blob: URL for the file; revoke it with URL.revokeObjectURL when done. */
export async function fetchPrivateFileUrl(url: string, token: string): Promise<string> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || translate(getAppLanguage(), 'documents.openFailed'));
  }
  return URL.createObjectURL(await r.blob());
}

/** Opens the file in a new tab. Call it straight from a click: the tab is
 *  opened before the fetch so popup blockers allow it. */
export async function openPrivateFile(url: string, token: string): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const blobUrl = await fetchPrivateFileUrl(url, token);
    if (win) win.location.href = blobUrl;
    else window.location.assign(blobUrl);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
  } catch (e) {
    win?.close();
    throw e;
  }
}
