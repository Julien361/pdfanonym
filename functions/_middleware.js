// www.pdfanonym.com → pdfanonym.com (redirection permanente, chemin conservé).
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (url.hostname === "www.pdfanonym.com") {
    url.hostname = "pdfanonym.com";
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
