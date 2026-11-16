// 小さな Node.js：読者が書いた JavaScript を動かす（Cloud Shell の node コマンド、Cloud Run のコンテナ、Cloud Run functions）。
// require できるのは GCP.NODE_MODULES に登録したものだけ（http、express、@google-cloud/functions-framework、@google-cloud/firestore など）。
//   GCP.jsRun(code, env) → { exports, error }         モジュールとして 1 回実行する（同期の部分だけ）
//   env = { sys, w, who（ADC のアカウント）, project, filename, files（同じディレクトリのファイル）, log(sev, text), environ: {…}, server（listen したもの） }
//   GCP.settle() → Promise   「すぐ解決する Promise」を何回か待つ（SDK の呼び出しを最後まで進める）
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  G.NODE_MODULES = G.NODE_MODULES || {};
  G.NODE_VERSION = 'v22.11.0';

  // await しないで捨てた Promise の例外（unhandled rejection）を拾う
  G.trapRejections = (h) => {
    if (typeof window !== 'undefined' && window.addEventListener) { const f = (ev) => { ev.preventDefault(); h(ev.reason); }; window.addEventListener('unhandledrejection', f); return () => window.removeEventListener('unhandledrejection', f); }
    if (typeof process !== 'undefined' && process.on) { const f = (e) => h(e); process.on('unhandledRejection', f); return () => process.off('unhandledRejection', f); }
    return () => {};
  };
  G.preloadEngines = async (code) => {
    try {
      if (/@google-cloud\/bigquery/.test(code) && G.DUCK) await G.DUCK();
      if (/require\(['"]pg['"]\)/.test(code) && G.PG) await G.PG();
    } catch (e) {}
  };
  G.settle = async (n = 12) => { for (let k = 0; k < n; k++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0))); };

  // console の出力を 1 行にする（Node の util.format に近く）
  function fmtArg(x, top) {
    if (typeof x === 'string') return top ? x : `'${x}'`;
    if (x === undefined) return 'undefined';
    if (x === null) return 'null';
    if (typeof x === 'function') return `[Function: ${x.name || '(anonymous)'}]`;
    if (x instanceof Error) return x.stack ? `${x.name}: ${x.message}\n    at <anonymous>` : `${x.name}: ${x.message}`;
    if (typeof x === 'object') {
      if (x.__inspect) return x.__inspect();
      try { return inspect(x, 0); } catch (e) { return String(x); }
    }
    return String(x);
  }
  function inspect(v, d) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return d === 0 ? `'${v}'` : `'${v}'`;
    if (typeof v !== 'object') return String(v);
    if (v instanceof Date) return v.toISOString();
    if (v.__inspect) return v.__inspect();
    if (d > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (Array.isArray(v)) { const items = v.map((x) => inspect(x, d + 1)); const one = `[ ${items.join(', ')} ]`; return !items.length ? '[]' : one.length <= 72 ? one : `[\n${items.map((s) => '  '.repeat(d + 1) + s).join(',\n')}\n${'  '.repeat(d)}]`; }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const kv = keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${inspect(v[k], d + 1)}`);
    const one = `{ ${kv.join(', ')} }`;
    return one.length <= 72 ? one : `{\n${kv.map((s) => '  '.repeat(d + 1) + s).join(',\n')}\n${'  '.repeat(d)}}`;
  }
  G.inspect = (v) => inspect(v, 0);
  const fmtLine = (args) => args.map((x, k) => fmtArg(x, true)).join(' ');

  // Node 風のエラー表示
  G.nodeErrText = (e, filename) => {
    const name = (e && e.name) || 'Error';
    const msg = (e && e.message) || String(e);
    const extra = e && e.code ? ` {\n  code: ${typeof e.code === 'number' ? e.code : `'${e.code}'`}${e.details ? `,\n  details: '${e.details}'` : ''}\n}` : '';
    return `${filename}:1\n\n${name}: ${msg}\n    at Object.<anonymous> (${filename})${extra}\n\nNode.js ${G.NODE_VERSION}\n`;
  };

  // いちばん外側で呼んだだけの関数（main(); や p.then(…); ）の Promise を見張る。await されずに失敗したら、Node と同じく異常終了にする
  // （ブラウザの unhandledrejection だけでは、検査の環境で拾えないため）
  function trackTopLevel(code) {
    const lines = code.split('\n');
    const nextSig = (k) => { for (let j = k + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j].trim(); return ''; };
    let depth = 0;
    return lines.map((l, k) => {
      const out = depth === 0 && /^[A-Za-z_$][\w$.]*\(.*\)\s*;?\s*$/.test(l) && !/^(if|for|while|switch|return|function)\b/.test(l) && !nextSig(k).startsWith('.') && balanced(l)
        ? `__track(${l.replace(/;?\s*$/, '')});` : l;
      for (const ch of l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) { if (ch === '{' || ch === '(' || ch === '[') depth++; else if (ch === '}' || ch === ')' || ch === ']') depth--; }
      return out;
    }).join('\n');
  }
  const balanced = (l) => { let d = 0; for (const ch of l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) { if ('({['.includes(ch)) d++; else if (')}]'.includes(ch)) { d--; if (d < 0) return false; } } return d === 0; };
  // 1 つのモジュールを実行する
  G.jsRun = (code, env) => {
    const module = { exports: {} };
    const logs = (sev, t) => (env.log || (() => {}))(sev, t);
    const con = {
      log: (...a) => logs('INFO', fmtLine(a)), info: (...a) => logs('INFO', fmtLine(a)), debug: (...a) => logs('DEBUG', fmtLine(a)),
      warn: (...a) => logs('WARNING', fmtLine(a)), error: (...a) => logs('ERROR', fmtLine(a)),
      table: (rows) => logs('INFO', G.inspect(rows)),
    };
    const loading = env.loading || new Set();
    const req = (name) => {
      if (name.startsWith('./') || name.startsWith('../')) {
        const f = name.replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
        const src = (env.files || {})[f] !== undefined ? env.files[f] : (env.files || {})[name.replace(/^\.\//, '')];
        if (src === undefined) { const e = new Error(`Cannot find module '${name}'\nRequire stack:\n- ${env.filename}`); e.code = 'MODULE_NOT_FOUND'; throw e; }
        if (/\.json$/.test(name)) return JSON.parse(src);
        if (loading.has(f)) return {};
        loading.add(f);
        const r = G.jsRun(src, Object.assign({}, env, { filename: f, loading }));
        if (r.error) throw r.error;
        return r.exports;
      }
      const m = G.NODE_MODULES[name.replace(/^node:/, '')];
      if (!m) { const e = new Error(`Cannot find module '${name}'\nRequire stack:\n- ${env.filename}`); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return m(env);
    };
    const proc = {
      env: Object.assign({}, env.environ || {}), argv: ['/usr/bin/node', env.filename].concat(env.argv || []), exitCode: 0,
      exit: (c) => { const e = new Error('process.exit'); e.__exit = c === undefined ? 0 : c; throw e; },
      on: () => proc, version: G.NODE_VERSION, platform: 'linux', cwd: () => env.cwd || '/workspace',
      stdout: { write: (s) => { logs('RAW', String(s)); return true; } }, stderr: { write: (s) => { logs('RAWERR', String(s)); return true; } },
      memoryUsage: () => ({ rss: 41943040, heapTotal: 6291456, heapUsed: 4718592 }), uptime: () => 1.2, hrtime: { bigint: () => BigInt(env.w ? env.w.t * 1e6 : 0) },
    };
    const timers = env.timers || [];
    const fakeSetTimeout = (fn, ms, ...a) => { timers.push({ fn, a }); return timers.length; };
    let error = null;
    try {
      // 「use strict」の関数として実行する。グローバルの多くはそのまま見える（読者自身のブラウザの中なので、隠すのは手間に見合わない）
      const f = new Function('require', 'module', 'exports', 'console', 'process', '__filename', '__dirname', 'setTimeout', 'Buffer', '__track', '"use strict";\n' + trackTopLevel(code) + '\n//# sourceURL=' + env.filename);
      const track = (v) => { if (v && typeof v.then === 'function') v.then(null, (e) => { if (env.onReject) env.onReject(e); }); return v; };
      f(req, module, module.exports, con, proc, '/workspace/' + env.filename, '/workspace', fakeSetTimeout, G.Buffer, track);
    } catch (e) { error = e; }
    return { exports: module.exports, error, process: proc, timers };
  };

  // Buffer（base64 だけ）
  G.Buffer = {
    from: (s, enc) => {
      if (enc === 'base64') { const t = G.b64dec(String(s)); return { toString: () => t, length: t.length, __b: true }; }
      const t = typeof s === 'string' ? s : s && s.__b ? s.toString() : JSON.stringify(s);
      return { toString: (e) => (e === 'base64' ? G.b64enc(t) : t), length: new TextEncoder().encode(t).length, __b: true };
    },
    isBuffer: (x) => !!(x && x.__b),
  };

  // ---------------------------------------------------------------- http と express（Cloud Run のコンテナの中）
  // ハンドラは (req, res)。res は書いた内容を集める
  G.makeRes = () => {
    const res = {
      statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '', ended: false, _type: null,
      status(c) { res.statusCode = c; return res; }, set(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, header(k, v) { return res.set(k, v); },
      type(t) { res.headers['content-type'] = t.includes('/') ? t : t === 'json' ? 'application/json; charset=utf-8' : 'text/' + t + '; charset=utf-8'; return res; },
      writeHead(c, h) { res.statusCode = c; for (const k of Object.keys(h || {})) res.headers[k.toLowerCase()] = h[k]; return res; },
      write(s) { res.body += String(s); return true; },
      end(s) { if (s !== undefined) res.body += String(s); res.ended = true; return res; },
      send(s) { if (s !== null && typeof s === 'object') return res.json(s); if (typeof s === 'number') { res.statusCode = s; s = G.STATUS[s] || String(s); } if (!res._typed && typeof s === 'string' && !/^\s*</.test(s)) res.headers['content-type'] = 'text/html; charset=utf-8'; res.body += s === undefined ? '' : String(s); res.ended = true; return res; },
      json(o) { res.headers['content-type'] = 'application/json; charset=utf-8'; res.body += JSON.stringify(o); res.ended = true; return res; },
      sendStatus(c) { res.statusCode = c; res.headers['content-type'] = 'text/plain; charset=utf-8'; res.body = G.STATUS[c] || String(c); res.ended = true; return res; },
      redirect(a, b) { const [code, url] = b === undefined ? [302, a] : [a, b]; res.statusCode = code; res.headers.location = url; res.body = `Found. Redirecting to ${url}`; res.ended = true; return res; },
    };
    return res;
  };
  G.NODE_MODULES.http = (env) => ({
    createServer: (handler) => {
      const srv = { handler, listening: null, listen: (port, host, cb) => { if (typeof host === 'function') cb = host; srv.listening = Number(port); if (env.server) env.server.list.push(srv); if (cb) cb(); return srv; }, on: () => srv, close: () => {} };
      return srv;
    },
    STATUS_CODES: G.STATUS,
  });
  G.NODE_MODULES.express = (env) => {
    const express = () => {
      const routes = [], mws = [];
      const app = (req, res) => app.handle(req, res);
      const add = (method) => (path, ...fns) => { routes.push({ method, path, fns }); return app; };
      app.get = add('GET'); app.post = add('POST'); app.put = add('PUT'); app.delete = add('DELETE'); app.patch = add('PATCH'); app.all = add('*');
      app.use = (a, b) => { if (typeof a === 'function') mws.push({ path: '/', fn: a }); else mws.push({ path: a, fn: b }); return app; };
      app.set = () => app; app.disable = () => app; app.enable = () => app;
      app.handle = async (req, res) => {
        const chain = mws.filter((m) => req.path.startsWith(m.path)).map((m) => m.fn);
        let route = null, params = {};
        for (const r of routes) {
          if (r.method !== '*' && r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
          const keys = [];
          const re = new RegExp('^' + r.path.replace(/\/:(\w+)/g, (m, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*/g, '.*') + '/?$');
          const m = req.path.match(re);
          if (m) { route = r; keys.forEach((k, j) => { params[k] = decodeURIComponent(m[j + 1]); }); break; }
        }
        req.params = params;
        const fns = chain.concat(route ? route.fns : [(q, s) => { s.status(404).set('content-type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${req.method} ${req.path}</pre>\n</body>\n</html>\n`); }]);
        let k = 0;
        const next = async (err) => { if (err) throw err; const f = fns[k++]; if (f) await f(req, res, next); };
        await next();
      };
      app.listen = (port, cb) => { const srv = { handler: app, listening: Number(port) }; if (env.server) env.server.list.push(srv); if (typeof cb === 'function') cb(); return srv; };
      return app;
    };
    express.json = () => (req, res, next) => { if (/json/.test(req.headers['content-type'] || '') && typeof req.body === 'string') { try { req.body = req.body ? JSON.parse(req.body) : {}; } catch (e) { res.status(400).send('Bad Request'); return; } } return next(); };
    express.urlencoded = () => (req, res, next) => next();
    express.static = () => (req, res, next) => next();
    express.Router = () => express();
    return express;
  };
  // Functions Framework
  G.NODE_MODULES['@google-cloud/functions-framework'] = (env) => ({
    http: (name, fn) => { (env.fns = env.fns || {})[name] = { kind: 'http', fn }; },
    cloudEvent: (name, fn) => { (env.fns = env.fns || {})[name] = { kind: 'event', fn }; },
  });
  // よく使う小さなもの
  G.NODE_MODULES.os = () => ({ hostname: () => 'localhost', platform: () => 'linux', cpus: () => [{}, {}], EOL: '\n' });
  G.NODE_MODULES.util = () => ({ inspect: (v) => G.inspect(v), format: (...a) => fmtLine(a), promisify: (f) => f });
  G.NODE_MODULES.crypto = (env) => ({ randomUUID: () => G.uuid('rnd' + (env.w ? G.seq(env.w, 'uuid') : 0)), createHash: () => ({ update: (s) => ({ digest: () => G.hex(String(s), 40) }) }) });
  G.NODE_MODULES.path = () => ({ join: (...a) => a.join('/').replace(/\/+/g, '/'), basename: (s) => G.basename(s), extname: (s) => (s.match(/\.[^./]+$/) || [''])[0] });
  G.NODE_MODULES.fs = (env) => ({
    readFileSync: (p) => { const f = (env.files || {})[String(p).replace(/^\.\//, '').replace(/^\/workspace\//, '')]; if (f === undefined) { const e = new Error(`ENOENT: no such file or directory, open '${p}'`); e.code = 'ENOENT'; throw e; } return f; },
    existsSync: (p) => (env.files || {})[String(p).replace(/^\.\//, '')] !== undefined,
    writeFileSync: (p, s) => { if (env.files) env.files[String(p).replace(/^\.\//, '')] = String(s); },
  });

  // ---------------------------------------------------------------- Cloud Shell の node コマンド
  G.CMDS.node = async (sys, a, io) => {
    if (a[0] === '-v' || a[0] === '--version') { io.out(G.NODE_VERSION + '\n'); return 0; }
    if (a[0] === '-e' || a[0] === '-p') {
      await G.preloadEngines(a[1] || '');
      const env = nodeEnv(sys, io, '[eval]', {});
      const untrap = G.trapRejections((e) => { env.rejected = env.rejected || e; });
      const r = G.jsRun(a[0] === '-p' ? `console.log(${a[1]})` : a[1], env);
      await G.settle();
      untrap();
      const err = r.error || env.rejected;
      if (err) { io.err(G.nodeErrText(err, '[eval]')); return 1; }
      return 0;
    }
    const file = a[0];
    if (!file) { io.err('このサイトの node は、ファイルを指定して実行します（例：node app.js）。対話モード（REPL）はありません。\n'); return 1; }
    const src = G.fs.read(sys, file);
    if (src === null) { io.err(`node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${G.fs.norm(sys, file)}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at node:internal/main/run_main_module:28:49 {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js ${G.NODE_VERSION}\n`); return 1; }
    const dir = G.fs.norm(sys, file).replace(/\/[^/]*$/, '');
    const files = G.fs.tree(sys, dir);
    // データベースのエンジン（非同期で読み込む）は、先に用意しておく
    await G.preloadEngines(Object.values(files).join('\n') + src);
    const env = nodeEnv(sys, io, G.fs.norm(sys, file), files, a.slice(1));
    const untrap = G.trapRejections((e) => { env.rejected = env.rejected || e; });
    const r = G.jsRun(src, env);
    // SDK の Promise を最後まで進める。読者の async 関数の中の例外は、unhandled rejection として拾う
    await G.settle();
    for (let k = 0; k < 6 && env.timers.length; k++) { const t = env.timers.splice(0); for (const x of t) { try { x.fn(...x.a); } catch (e) { r.error = r.error || e; } } await G.settle(); }
    await G.settle(4);
    untrap();
    // fs.writeFileSync で書いたもの
    for (const [k, v] of Object.entries(files)) G.fs.write(sys, dir + '/' + k, v);
    const err = r.error || env.rejected;
    if (err && err.__exit !== undefined) return err.__exit;
    if (err) { io.err(env.rejected && !r.error ? G.nodeErrText(err, G.fs.norm(sys, file)).replace(/^[^\n]*\n\n/, '') : G.nodeErrText(err, G.fs.norm(sys, file))); return 1; }
    return r.process.exitCode || 0;
  };
  function nodeEnv(sys, io, filename, files, argv) {
    const env = {
      sys, w: sys.w, filename, files, argv, timers: [], cwd: sys.sh.cwd,
      who: sys.vm ? sys.vm.sa : (sys.w.adc || 'you@tsubame.example'), project: sys.vm ? sys.vm.project : G.cfgGet(sys.w, 'core/project'),
      environ: Object.assign({ HOME: '/home/you', GOOGLE_CLOUD_PROJECT: G.cfgGet(sys.w, 'core/project') || '' }, sys.sh.vars),
      log: (sev, text) => { if (sev === 'RAW') io.out(text); else if (sev === 'RAWERR') io.err(text); else if (sev === 'ERROR' || sev === 'WARNING') io.err(text + '\n'); else io.out(text + '\n'); },
    };
    // SDK の呼び出しで投げた例外を、await しないで捨てたとき
    env.onReject = (e) => { env.rejected = env.rejected || e; };
    return env;
  }
})(typeof window !== 'undefined' ? window : globalThis);
