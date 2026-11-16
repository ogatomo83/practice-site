// HTTP の行き先（Cloud Run の URL、VM の外部 IP、storage.googleapis.com、各 API）と curl。
//   GCP.http(sys, req) → { status, headers:{}, body }   req = { method, url, headers:{小文字のキー}, body }
//   行き先は GCP.ROUTES に { name, match(url) → 真偽, handle(sys, req, u) → 応答 } を足す
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  G.ROUTES = G.ROUTES || [];
  const STATUS = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
  G.STATUS = STATUS;

  // Authorization: Bearer … のトークンから、だれかを知る
  G.bearer = (w, req) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(\S+)/i);
    if (!m) return { who: null };
    const t = w.tokens[m[1]];
    if (!t) return { who: null, bad: true };
    if (t.exp < w.t) return { who: null, bad: true, expired: true };
    return { who: t.who, kind: t.kind };
  };
  G.json = (status, obj, extra) => ({ status, headers: Object.assign({ 'content-type': 'application/json; charset=UTF-8' }, extra || {}), body: JSON.stringify(obj, null, 2) + '\n' });
  G.apiError = (status, message, st) => G.json(status, { error: { code: status, message, status: st || (status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : 'INVALID_ARGUMENT') } });

  G.http = async (sys, req) => {
    let u;
    try { u = new URL(req.url); } catch (e) { return { error: 3, msg: `URL rejected: Malformed input to a URL function` }; }
    sys.lastReq = req;
    for (const r of G.ROUTES) {
      if (r.match(sys.w, u, req)) return r.handle(sys, req, u);
    }
    return { error: 6, msg: `Could not resolve host: ${u.hostname}` };
  };

  // ---------------------------------------------------------------- Google の API を直接（REST で）呼ぶ
  G.ROUTES.push({
    name: 'resourcemanager',
    match: (w, u) => u.hostname === 'cloudresourcemanager.googleapis.com',
    handle: (sys, req, u) => {
      const w = sys.w;
      const b = G.bearer(w, req);
      if (!b.who) return G.json(401, { error: { code: 401, message: 'Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.', status: 'UNAUTHENTICATED' } });
      const m = u.pathname.match(/^\/v[13]\/projects\/([^/:]+)$/);
      if (m && req.method === 'GET') {
        const id = G.resolveProject(w, m[1]);
        const p = w.projects[id];
        if (!p || !G.check(w, b.who, 'resourcemanager.projects.get', 'projects/' + id).ok) return G.json(403, { error: { code: 403, message: "The caller does not have permission", status: 'PERMISSION_DENIED' } });
        if (u.pathname.startsWith('/v3/')) return G.json(200, { name: 'projects/' + p.projectNumber, parent: p.parent ? (p.parent.type === 'folder' ? 'folders/' : 'organizations/') + p.parent.id : undefined, projectId: p.projectId, state: p.lifecycleState === 'ACTIVE' ? 'ACTIVE' : 'DELETE_REQUESTED', displayName: p.name, createTime: p.createTime, updateTime: p.createTime, etag: 'W/"' + G.hex(p.projectId, 16) + '"', labels: p.labels });
        return G.json(200, { projectNumber: p.projectNumber, projectId: p.projectId, lifecycleState: p.lifecycleState, name: p.name, labels: p.labels, createTime: p.createTime, parent: p.parent });
      }
      return G.json(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
    },
  });

  // ---------------------------------------------------------------- curl
  G.CMDS.curl = async (sys, a, io) => {
    const req = { method: null, headers: {}, body: undefined, url: null };
    let silent = false, showErr = false, incl = false, head = false, outFile = null, writeOut = null, fail = false, connTimeout = null, maxTime = null, verbose = false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (/^-[a-zA-Z]{2,}$/.test(x) && !/^-(X|H|d|o|w)$/.test(x)) {
        // -sS や -si のようにまとめた指定
        for (const ch of x.slice(1)) { if (ch === 's') silent = true; else if (ch === 'S') showErr = true; else if (ch === 'i') incl = true; else if (ch === 'I') head = true; else if (ch === 'f') fail = true; else if (ch === 'L') {} else if (ch === 'v') verbose = true; else if (ch === 'k') {} }
        continue;
      }
      switch (x) {
        case '-s': case '--silent': silent = true; break;
        case '-S': case '--show-error': showErr = true; break;
        case '-i': case '--include': incl = true; break;
        case '-I': case '--head': head = true; break;
        case '-f': case '--fail': fail = true; break;
        case '-L': case '--location': case '-k': case '--insecure': break;
        case '-v': case '--verbose': verbose = true; break;
        case '-X': case '--request': req.method = a[++i]; break;
        case '-H': case '--header': { const h = a[++i] || ''; const k = h.indexOf(':'); if (k > 0) req.headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim(); break; }
        case '-d': case '--data': case '--data-raw': case '--data-binary': {
          let d = a[++i] || '';
          if (d.startsWith('@')) { const s = G.fs.read(sys, d.slice(1)); if (s === null) { io.err(`Warning: Couldn't read data from file "${d.slice(1)}", this makes an empty POST.\n`); d = ''; } else d = x === '--data-binary' ? s : s.replace(/\n/g, ''); }
          req.body = (req.body ? req.body + '&' : '') + d;
          if (!req.headers['content-type']) req.headers['content-type'] = 'application/x-www-form-urlencoded';
          break;
        }
        case '--json': req.body = a[++i]; req.headers['content-type'] = 'application/json'; req.headers.accept = 'application/json'; break;
        case '-o': case '--output': outFile = a[++i]; break;
        case '-w': case '--write-out': writeOut = a[++i]; break;
        case '--connect-timeout': connTimeout = parseFloat(a[++i]); break;
        case '-m': case '--max-time': maxTime = parseFloat(a[++i]); break;
        default:
          if (x.startsWith('-')) { io.err(`curl: option ${x}: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information\n`); return 2; }
          req.url = x;
      }
    }
    if (!req.url) { io.err("curl: no URL specified\ncurl: try 'curl --help' or 'curl --manual' for more information\n"); return 2; }
    if (!/^[a-z]+:\/\//i.test(req.url)) req.url = 'http://' + req.url;
    req.method = req.method || (head ? 'HEAD' : req.body !== undefined ? 'POST' : 'GET');
    req.connTimeout = connTimeout; req.maxTime = maxTime;
    const r = await G.http(sys, req);
    const errOut = (code, msg) => { if (!silent || showErr) io.err(`curl: (${code}) ${msg}\n`); return code; };
    if (r.error) { if (r.wait) G.advance(sys.w, r.wait); return errOut(r.error, r.msg); }
    if (r.wait) G.advance(sys.w, r.wait);
    const status = r.status;
    const hdrs = Object.assign({}, r.headers || {});
    const body = req.method === 'HEAD' ? '' : r.body || '';
    hdrs['content-length'] = hdrs['content-length'] || String(new TextEncoder().encode(r.body || '').length);
    const headText = `HTTP/2 ${status} \n` + Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
    if (verbose) io.err(`*   Trying ${new URL(req.url).hostname}...\n> ${req.method} ${new URL(req.url).pathname} HTTP/2\n> Host: ${new URL(req.url).host}\n${Object.entries(req.headers).map(([k, v]) => `> ${k}: ${k === 'authorization' ? v.slice(0, 20) + '…' : v}`).join('\n')}\n>\n< HTTP/2 ${status}\n`);
    if (fail && status >= 400) return errOut(22, `The requested URL returned error: ${status}`);
    let text = (incl || head ? headText : '') + body;
    if (outFile) { G.fs.write(sys, outFile, body); text = incl || head ? headText : ''; }
    io.out(text);
    if (writeOut) io.out(writeOut.replace(/%\{http_code\}/g, String(status)).replace(/%\{content_type\}/g, hdrs['content-type'] || '').replace(/%\{size_download\}/g, String(body.length)).replace(/\\n/g, '\n'));
    return 0;
  };
})(typeof window !== 'undefined' ? window : globalThis);
