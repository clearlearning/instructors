/* The Facilitator Portal at /facilitator. It serves the same page as the Instructor Portal (index.html), which switches
   to the facilitator view from its address. Cloudflare Access protects /facilitator with its own application. */
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  url.pathname = '/';
  return env.ASSETS.fetch(new Request(url.toString(), request));
}
