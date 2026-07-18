const INDEX_PATH = '/index.html';

export default {
  async fetch(request, env) {
    if (!env?.ASSETS?.fetch) {
      return new Response('Static asset binding unavailable.', { status: 503 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/') url.pathname = INDEX_PATH;
    let response = await env.ASSETS.fetch(new Request(url, request));
    if (response.status === 404 && request.method === 'GET' && !url.pathname.includes('.')) {
      url.pathname = INDEX_PATH;
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    return response;
  },
};
