// Cloud Storage：バケットとオブジェクト（gcloud storage …）、世代（バージョニング）、ライフサイクル、IAM と公開、storage.googleapis.com の URL。
// 状態：w.svc.storage.buckets[名前] = { project, location, locationType, cls, created, updated, versioning, ubla, pap, labels, lifecycle, metageneration, objects: { 名前: [世代…] } }
//   世代 = { gen, data, size, ctype, created, cls, live, deleted? }
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.storage = () => ({ buckets: {} });
  // 世界のどこか（ほかの会社）ですでに使われている名前
  const TAKEN = new Set(['test', 'data', 'backup', 'images', 'my-bucket', 'tsubame', 'tsubame-bungu', 'photos', 'logs', 'assets', 'static', 'uploads', 'shop', 'example', 'bucket', 'public', 'files', 'tsubame-images']);
  const REGIONS = ['asia-northeast1', 'asia-northeast2', 'asia-northeast3', 'asia-east1', 'asia-southeast1', 'us-central1', 'us-east1', 'us-west1', 'europe-west1', 'europe-west4', 'australia-southeast1'];
  const MULTI = { US: 'multi-region', EU: 'multi-region', ASIA: 'multi-region' };
  const DUAL = { ASIA1: 'dual-region', EUR4: 'dual-region', NAM4: 'dual-region' };
  G.GCS_REGIONS = REGIONS;
  const CLASSES = ['STANDARD', 'NEARLINE', 'COLDLINE', 'ARCHIVE'];
  const S = (w) => w.svc.storage;

  const parseUrl = (s) => {
    const m = String(s).match(/^gs:\/\/([^/]+)\/?(.*)$/);
    if (!m) return null;
    let obj = m[2], gen = null;
    const g = obj.match(/^(.*)#(\d+)$/);
    if (g) { obj = g[1]; gen = g[2]; }
    return { bucket: m[1], obj, gen };
  };
  const bucketRes = (b, name) => `projects/${b.project}/buckets/${name}`;
  const humanB = (n) => { if (n < 1024) return n.toFixed(1) + 'B'; const u = ['kiB', 'MiB', 'GiB', 'TiB']; let x = n, k = -1; while (x >= 1024 && k < 3) { x /= 1024; k++; } return x.toFixed(1) + u[k]; };
  const humanL = (n) => { if (n < 1024) return n + 'B'; const u = ['kiB', 'MiB', 'GiB', 'TiB']; let x = n, k = -1; while (x >= 1024 && k < 3) { x /= 1024; k++; } return x.toFixed(2) + u[k]; };
  const bytes = (s) => new TextEncoder().encode(s).length;
  const isoS = (t) => G.iso(t, 0).replace('Z', '+00:00').replace('T', 'T');
  const ctypeOf = (n) => /\.html?$/.test(n) ? 'text/html' : /\.txt$/.test(n) ? 'text/plain' : /\.csv$/.test(n) ? 'text/csv' : /\.json$/.test(n) ? 'application/json' : /\.png$/.test(n) ? 'image/png' : /\.jpe?g$/.test(n) ? 'image/jpeg' : /\.css$/.test(n) ? 'text/css' : /\.js$/.test(n) ? 'text/javascript' : 'application/octet-stream';
  G.ctypeOf = ctypeOf;

  // バケットを探して、権限を調べる。なければ 404
  function getBucket(c, name, perm, opts = {}) {
    const b = S(c.w).buckets[name];
    const who = c.as();
    if (!b) {
      if (TAKEN.has(name)) throw httpErr(403, `${who} does not have ${perm} access to the Google Cloud Storage bucket. Permission '${perm}' denied on resource (or it may not exist).`);
      throw httpErr(404, `gs://${name} not found: 404.`, true);
    }
    const p = c.w.projects[b.project];
    if (p && !p.services.includes('storage.googleapis.com') && !p.services.includes('storage-api.googleapis.com')) {}
    if (perm) {
      if (G.scopeCheck) G.scopeCheck(c, /\.(create|delete|update|setIamPolicy)$/.test(perm) ? 'storage-write' : 'storage-read');
      const r = G.check(c.w, who, perm, bucketRes(b, name));
      G.KNOWN.add(perm);
      if (!r.ok) throw httpErr(403, `${who} does not have ${perm} access to the Google Cloud Storage ${opts.obj ? 'object' : 'bucket'}. Permission '${perm}' denied on resource (or it may not exist).`);
    }
    if (c.logHttp) c.err(`=======================\n==== request start ====\nuri: https://storage.googleapis.com/storage/v1/b/${name}${opts.obj !== undefined ? '/o/' + encodeURIComponent(opts.obj) : ''}?alt=json\nmethod: ${opts.verb || 'GET'}\n== headers start ==\nb'authorization': --- Token Redacted ---\n== headers end ==\n==== request end ====\n`);
    G.tick(c.w, 30);
    return b;
  }
  function httpErr(code, msg, bare) { const e = new G.Err(code, 'HTTP', msg); e.gcloud = bare ? msg : `HTTPError ${code}: ${msg}`; return e; }
  const live = (b, name) => { const gens = b.objects[name]; if (!gens) return null; return gens.find((g) => g.live) || null; };
  const objView = (b, bname, name, g) => ({
    bucket: bname, content_type: g.ctype, crc32c_hash: G.b64enc(G.hex('crc' + g.data, 8)).slice(0, 8), creation_time: isoS(g.created), generation: String(g.gen), md5_hash: G.b64enc(G.hex('md5' + g.data, 16)).slice(0, 22) + '==',
    metageneration: 1, name, size: g.size, storage_class: g.cls, storage_class_update_time: isoS(g.created), storage_url: `gs://${bname}/${name}#${g.gen}`, update_time: isoS(g.created),
    noncurrent_time: g.live ? undefined : isoS(g.noncurrent || g.created), custom_metadata: g.meta && Object.keys(g.meta).length ? g.meta : undefined,
  });
  const bucketView = (w, name, b) => ({
    creation_time: isoS(b.created), default_storage_class: b.cls, location: b.location, location_type: b.locationType, metageneration: b.metageneration, name,
    public_access_prevention: b.pap, rpo: b.locationType === 'region' ? undefined : 'DEFAULT', soft_delete_policy: { effectiveTime: isoS(b.created), retentionDurationSeconds: '604800' },
    storage_url: `gs://${name}/`, uniform_bucket_level_access: b.ubla, update_time: isoS(b.updated), versioning_enabled: b.versioning || undefined,
    labels: Object.keys(b.labels).length ? b.labels : undefined, lifecycle_config: b.lifecycle ? { rule: b.lifecycle } : undefined,
    default_acl: undefined, project_number: w.projects[b.project] ? w.projects[b.project].projectNumber : undefined,
  });

  // ---------------------------------------------------------------- バケット
  G.gc('storage buckets create', { pos: ['URL …'], flags: { location: 'v', l: 'v', 'default-storage-class': 'v', c: 'v', 'uniform-bucket-level-access': 'b', b: 'b', 'public-access-prevention': 'b', pap: 'b', 'enable-autoclass': 'b', 'soft-delete-duration': 'v', 'placement': 'v' }, run: async (c) => {
    const pid = c.need();
    for (const url of c.p) {
      const u = parseUrl(url);
      if (!u || u.obj) throw E.usage(`Expected a bucket URL like gs://bucket, but got ${url}`);
      const name = u.bucket;
      if (!/^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/.test(name) || /\.\./.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name)) throw httpErr(400, `Invalid bucket name: '${name}'`);
      if (/^goog|google|g00gle/.test(name)) throw httpErr(400, `Invalid bucket name: '${name}'`);
      c.err(`Creating gs://${name}/...\n`);
      c.call({ method: 'storage.buckets.create', perm: 'storage.buckets.create', res: 'projects/' + pid, svc: 'storage.googleapis.com', project: pid, resType: 'gcs_bucket', resLabels: { bucket_name: name, location: (c.a.location || c.a.l || 'US').toLowerCase() }, resourceName: `projects/_/buckets/${name}`,
        deniedMsg: (who) => `${who} does not have storage.buckets.create access to the Google Cloud project. Permission 'storage.buckets.create' denied on resource (or it may not exist).` });
      if (!c.w.projects[pid].billing) throw httpErr(403, 'The billing account for the owning project is disabled in state absent');
      if (S(c.w).buckets[name] || TAKEN.has(name)) throw httpErr(409, 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.');
      let loc = (c.a.location || c.a.l || 'US').toUpperCase();
      const locType = MULTI[loc] ? 'multi-region' : DUAL[loc] ? 'dual-region' : REGIONS.includes(loc.toLowerCase()) ? 'region' : null;
      if (!locType) throw httpErr(400, `Invalid location: ${loc}`);
      const rl = G.orgPolicyOf(c.w, 'projects/' + pid, 'gcp.resourceLocations');
      if (rl) { const allow = ((rl.spec.rules || [])[0] || {}).values ? rl.spec.rules[0].values.allowedValues || [] : []; if (!allow.some((x) => x.replace(/^in:/, '').replace(/-locations$/, '') === loc.toLowerCase() || (x === 'in:asia-locations' && /^ASIA/.test(loc)) || (x === 'in:jp-locations' && /^ASIA-NORTHEAST[12]$/.test(loc)))) throw httpErr(412, `'${loc.toLowerCase()}' violates constraint 'constraints/gcp.resourceLocations' on the resource 'projects/${pid}'.`); }
      const cls = (c.a['default-storage-class'] || c.a.c || 'STANDARD').toUpperCase();
      if (!CLASSES.includes(cls)) throw httpErr(400, `Invalid storage class: ${cls}`);
      const papPol = G.orgPolicyOf(c.w, 'projects/' + pid, 'storage.publicAccessPrevention');
      const ublaPol = G.orgPolicyOf(c.w, 'projects/' + pid, 'storage.uniformBucketLevelAccess');
      const ubla = !!(c.a['uniform-bucket-level-access'] || c.a.b || (ublaPol && ublaPol.spec.rules && ublaPol.spec.rules[0].enforce));
      if (!ubla && ublaPol && ublaPol.spec.rules && ublaPol.spec.rules[0].enforce) {}
      S(c.w).buckets[name] = {
        project: pid, location: loc, locationType: locType, cls, created: c.w.t, updated: c.w.t, versioning: false, ubla,
        pap: c.a['public-access-prevention'] || c.a.pap || (papPol && papPol.spec.rules && papPol.spec.rules[0].enforce) ? 'enforced' : 'inherited', labels: {}, lifecycle: null, metageneration: 1, objects: {},
      };
      // バケットを作った人のプロジェクトの基本ロールが、バケットの IAM に入る（本物は projectOwner: などの「便利な値」）
      c.w.policies[bucketRes({ project: pid }, name)] = { version: 1, etag: 'CAE=', bindings: [
        { role: 'roles/storage.legacyBucketOwner', members: [`projectEditor:${pid}`, `projectOwner:${pid}`] },
        { role: 'roles/storage.legacyBucketReader', members: [`projectViewer:${pid}`] },
        { role: 'roles/storage.legacyObjectOwner', members: [`projectEditor:${pid}`, `projectOwner:${pid}`] },
        { role: 'roles/storage.legacyObjectReader', members: [`projectViewer:${pid}`] },
      ] };
    }
  } });
  G.gc('storage buckets list', { pos: ['[URLS …]'], flags: {}, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'storage.buckets.list', perm: 'storage.buckets.list', res: 'projects/' + pid, svc: 'storage.googleapis.com', project: pid, read: true,
      deniedMsg: (who) => `${who} does not have storage.buckets.list access to the Google Cloud project. Permission 'storage.buckets.list' denied on resource (or it may not exist).` });
    return Object.keys(S(c.w).buckets).sort().filter((n) => S(c.w).buckets[n].project === pid).map((n) => bucketView(c.w, n, S(c.w).buckets[n]));
  } });
  G.gc('storage buckets describe', { pos: ['URL'], fmt: 'yaml', run: async (c) => {
    const u = parseUrl(c.p[0]);
    if (!u) throw E.usage(`Expected a bucket URL like gs://bucket, but got ${c.p[0]}`);
    const b = getBucket(c, u.bucket, 'storage.buckets.get');
    return bucketView(c.w, u.bucket, b);
  } });
  G.gc('storage buckets update', { pos: ['URL …'], flags: { versioning: 'b', 'default-storage-class': 'v', 'uniform-bucket-level-access': 'b', 'public-access-prevention': 'b', 'lifecycle-file': 'v', 'clear-lifecycle': 'b', 'update-labels': 'v', 'remove-labels': 'v' }, run: async (c) => {
    for (const url of c.p) {
      const u = parseUrl(url);
      const b = getBucket(c, u.bucket, 'storage.buckets.update', { verb: 'PATCH' });
      c.err(`Updating gs://${u.bucket}/...\n`);
      if (c.a.versioning !== undefined) b.versioning = c.a.versioning;
      if (c.a['default-storage-class']) b.cls = c.a['default-storage-class'].toUpperCase();
      if (c.a['uniform-bucket-level-access'] !== undefined) b.ubla = c.a['uniform-bucket-level-access'];
      if (c.a['public-access-prevention'] !== undefined) {
        b.pap = c.a['public-access-prevention'] ? 'enforced' : 'inherited';
      }
      if (c.a['lifecycle-file']) {
        const s = G.fs.read(c.sys, c.a['lifecycle-file']);
        if (s === null) throw E.plain(`[Errno 2] No such file or directory: '${c.a['lifecycle-file']}'`);
        let j; try { j = JSON.parse(s); } catch (e) { throw E.plain(`Found invalid JSON/YAML for the lifecycle rule`); }
        b.lifecycle = (j.lifecycle || j).rule || [];
      }
      if (c.a['clear-lifecycle']) b.lifecycle = null;
      if (c.a['update-labels']) for (const kv of c.a['update-labels'].split(',')) { const [k, v] = kv.split('='); b.labels[k] = v || ''; }
      if (c.a['remove-labels']) for (const k of c.a['remove-labels'].split(',')) delete b.labels[k];
      b.metageneration++;
      b.updated = c.w.t;
      c.err('  Completed 1   \n');
    }
  } });
  G.gc('storage buckets delete', { pos: ['URL …'], run: async (c) => {
    for (const url of c.p) {
      const u = parseUrl(url);
      const b = getBucket(c, u.bucket, 'storage.buckets.delete', { verb: 'DELETE' });
      c.err(`Removing gs://${u.bucket}/...\n`);
      if (Object.values(b.objects).some((gs) => gs.length)) throw httpErr(409, 'The bucket you tried to delete is not empty.');
      delete S(c.w).buckets[u.bucket];
      delete c.w.policies[bucketRes(b, u.bucket)];
      G.audit(c.w, { project: b.project, who: c.as(), method: 'storage.buckets.delete', perm: 'storage.buckets.delete', res: `projects/_/buckets/${u.bucket}`, svc: 'storage.googleapis.com', resType: 'gcs_bucket' });
    }
  } });
  G.iamCmds('storage buckets', { pos: 'URL', res: (c) => {
    const u = parseUrl(c.p[0]);
    if (!u) throw E.usage(`Expected a bucket URL like gs://bucket, but got ${c.p[0]}`);
    const b = S(c.w).buckets[u.bucket];
    if (!b) throw httpErr(404, `gs://${u.bucket} not found: 404.`, true);
    return {
      name: bucketRes(b, u.bucket), project: b.project, svc: 'storage.googleapis.com', getPerm: 'storage.buckets.getIamPolicy', setPerm: 'storage.buckets.setIamPolicy', kind: 'bucket', label: `gs://${u.bucket}`,
      pretty: `projects/_/buckets/${u.bucket}`, resType: 'gcs_bucket',
      check: (member) => {
        if ((member === 'allUsers' || member === 'allAuthenticatedUsers') && (b.pap === 'enforced' || G.orgPolicyOf(c.w, 'projects/' + b.project, 'storage.publicAccessPrevention'))) {
          throw httpErr(412, 'The member bindings allUsers and allAuthenticatedUsers are not allowed since public access prevention is enforced.');
        }
      },
    };
  } });

  // ---------------------------------------------------------------- オブジェクト
  // 1 つ書き込む（世代を足す）
  function putObject(c, b, bname, name, data, o = {}) {
    const gens = b.objects[name] = b.objects[name] || [];
    const prev = gens.find((g) => g.live);
    if (prev && o.ifNotExist) throw httpErr(412, `At least one of the pre-conditions you specified did not hold.`);
    if (prev) {
      if (b.versioning) { prev.live = false; prev.noncurrent = c.w.t; }
      else gens.splice(gens.indexOf(prev), 1);
    }
    const gen = String(G.T0 + c.w.t) + String(100 + (G.seq(c.w, 'gen') % 900));
    gens.push({ gen: Number(gen), data, size: bytes(data), ctype: o.ctype || ctypeOf(name), created: c.w.t, cls: o.cls || b.cls, live: true, meta: o.meta || {} });
    if (G.emit) G.emit(c.w, { kind: 'gcs.finalize', bucket: bname, name, gen: Number(gen), size: bytes(data), ctype: o.ctype || ctypeOf(name), cls: o.cls || b.cls });
    G.tick(c.w, 50);
  }
  G.gcsPut = (w, bname, name, data, o = {}) => { const b = S(w).buckets[bname]; if (b) putObject({ w }, b, bname, name, data, o); };
  G.gcsGet = (w, bname, name) => { const b = S(w).buckets[bname]; const g = b && live(b, name); return g ? g.data : null; };
  G.gcsBucket = (w, bname) => S(w).buckets[bname];
  function delObject(c, b, name, gen) {
    const gens = b.objects[name] || [];
    if (gen) { const k = gens.findIndex((g) => String(g.gen) === String(gen)); if (k < 0) return false; gens.splice(k, 1); }
    else {
      const g = gens.find((x) => x.live);
      if (!g) return false;
      if (b.versioning) { g.live = false; g.noncurrent = c.w.t; }
      else gens.splice(gens.indexOf(g), 1);
    }
    if (!gens.length) delete b.objects[name];
    return true;
  }
  // gs://b/pre* や gs://b/dir/** を展開する
  function expandObjects(b, pattern, all) {
    const names = Object.keys(b.objects).filter((n) => all ? b.objects[n].length : live(b, n)).sort();
    if (!/[*?]/.test(pattern)) return names.includes(pattern) ? [pattern] : [];
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$');
    return names.filter((n) => re.test(n));
  }

  G.gc('storage ls', { pos: ['[PATH …]'], flags: { l: 'b', long: 'b', L: 'b', r: 'b', recursive: 'b', a: 'b', 'all-versions': 'b', buckets: 'b', b: 'b', 'readable-sizes': 'b', 'soft-deleted': 'b' }, run: async (c) => {
    const long = c.a.l || c.a.long, all = c.a.a || c.a['all-versions'], rec = c.a.r || c.a.recursive;
    if (!c.p.length) {
      const pid = c.need();
      c.call({ method: 'storage.buckets.list', perm: 'storage.buckets.list', res: 'projects/' + pid, svc: 'storage.googleapis.com', project: pid, read: true,
        deniedMsg: (who) => `${who} does not have storage.buckets.list access to the Google Cloud project. Permission 'storage.buckets.list' denied on resource (or it may not exist).` });
      for (const n of Object.keys(S(c.w).buckets).sort()) if (S(c.w).buckets[n].project === pid) c.out(`gs://${n}/\n`);
      return;
    }
    let total = 0, count = 0, st = 0;
    for (const url of c.p) {
      const u = parseUrl(url);
      if (!u) throw E.plain(`ls は gs:// の URL を受け取ります（このサイトでは手元のファイルの一覧は ls を使ってください）：${url}`);
      const b = getBucket(c, u.bucket, 'storage.objects.list');
      if (c.a.b || c.a.buckets) { c.out(`gs://${u.bucket}/\n`); continue; }
      const pre = u.obj;
      let names;
      const lines = [];
      if (/[*?]/.test(pre)) names = expandObjects(b, pre, all);
      else {
        names = Object.keys(b.objects).filter((n) => (all ? b.objects[n].length : live(b, n)) && n.startsWith(pre)).sort();
        if (!rec) {
          // 「ディレクトリ」（/ までの接頭辞）にまとめる
          const dirs = new Set(), files = [];
          const base = pre && !pre.endsWith('/') && !names.includes(pre) && names.some((n) => n.startsWith(pre + '/')) ? pre + '/' : pre;
          for (const n of names) { const rest = n.slice(base.length); const k = rest.indexOf('/'); if (k >= 0) dirs.add(base + rest.slice(0, k + 1)); else if (n.startsWith(base)) files.push(n); }
          names = files;
          for (const d of [...dirs].sort()) lines.push({ name: d, dir: true });
        }
      }
      if (!names.length && !lines.length) {
        if (pre) { c.err(`ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\n`); st = 1; continue; }
        continue;
      }
      const items = [];
      for (const n of names) {
        const gens = all ? b.objects[n] : [live(b, n)];
        for (const g of gens) items.push({ name: n, g });
      }
      const rows = items.map((x) => ({ name: x.name, g: x.g })).concat(lines).sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : (p.g && q.g ? p.g.gen - q.g.gen : 0)));
      for (const r of rows) {
        if (r.dir) { c.out(long ? `                                 gs://${u.bucket}/${r.name}\n` : `gs://${u.bucket}/${r.name}\n`); continue; }
        const name = `gs://${u.bucket}/${r.name}${all ? '#' + r.g.gen : ''}`;
        if (long) { c.out(`${String(c.a['readable-sizes'] ? humanL(r.g.size) : r.g.size).padStart(10)}  ${G.iso(r.g.created, 0)}  ${name}${all && !r.g.live ? '' : ''}\n`); total += r.g.size; count++; }
        else c.out(name + '\n');
      }
    }
    if (long) c.out(`TOTAL: ${count} objects, ${total} bytes (${humanL(total)})\n`);
    c.exit = st;
  } });
  // 手元（ファイル）か gs:// か
  async function readSrc(c, src) {
    const u = parseUrl(src);
    if (!u) {
      if (src === '-') return [{ rel: '-', data: c.stdin, local: '-' }];
      const s = G.fs.read(c.sys, src);
      if (s !== null) return [{ rel: G.basename(src), data: s, local: src }];
      if (G.fs.isDir(c.sys, src)) {
        if (!c.a.r && !c.a.recursive && !c.a.R) throw E.plain(`Omitting directory "${src.replace(/\/$/, '')}". (Did you mean to do cp -r?)`);
        const t = G.fs.tree(c.sys, src);
        const base = G.basename(src.replace(/\/$/, ''));
        return Object.keys(t).sort().map((k) => ({ rel: base + '/' + k, data: t[k], local: G.fs.norm(c.sys, src) + '/' + k, inDir: k }));
      }
      throw E.plain(`The following URLs matched no objects or files:\n-${src}`);
    }
    const b = getBucket(c, u.bucket, 'storage.objects.get', { obj: u.obj });
    let names = /[*?]/.test(u.obj) ? expandObjects(b, u.obj) : live(b, u.obj) ? [u.obj] : [];
    if (!names.length && (c.a.r || c.a.recursive || c.a.R)) names = Object.keys(b.objects).filter((n) => live(b, n) && (u.obj === '' || n.startsWith(u.obj.replace(/\/?$/, '/')))).sort();
    if (u.gen) {
      const g = (b.objects[u.obj] || []).find((x) => String(x.gen) === u.gen);
      if (!g) throw E.plain(`The following URLs matched no objects or files:\n-${src}`);
      return [{ rel: G.basename(u.obj), data: g.data, gs: `gs://${u.bucket}/${u.obj}#${g.gen}`, g, name: u.obj, bucket: u.bucket }];
    }
    if (!names.length) throw E.plain(`The following URLs matched no objects or files:\n-${src}`);
    const pre = (c.a.r || c.a.recursive || c.a.R) && !/[*?]/.test(u.obj) && !live(b, u.obj) ? u.obj.replace(/\/?$/, '/') : null;
    return names.map((n) => ({ genTxt: false, rel: pre !== null ? (G.basename(u.obj.replace(/\/$/, '')) ? G.basename(u.obj.replace(/\/$/, '')) + '/' : '') + n.slice(pre.length) : G.basename(n), data: live(b, n).data, gs: `gs://${u.bucket}/${n}`, g: live(b, n), name: n, bucket: u.bucket }));
  }
  async function copy(c, mv) {
    const dst = c.p[c.p.length - 1];
    const srcs = c.p.slice(0, -1);
    if (!srcs.length) throw E.usage('argument DESTINATION: Must be specified.');
    const items = [];
    for (const s of srcs) items.push(...(await readSrc(c, s)));
    const du = parseUrl(dst);
    const many = items.length > 1 || items.some((x) => x.inDir !== undefined) || dst.endsWith('/');
    let n = 0, total = 0;
    for (const it of items) {
      const fromTxt = it.gs || (it.local === '-' ? '-' : 'file://' + G.fs.norm(c.sys, it.local));
      if (du) {
        const b = getBucket(c, du.bucket, 'storage.objects.create', { obj: du.obj, verb: 'POST' });
        let name = du.obj;
        if (!name || name.endsWith('/') || many) name = (name && !name.endsWith('/') ? name + '/' : name) + it.rel;
        if (live(b, name) && c.a['no-clobber']) { c.err(`Skipping existing destination item (no-clobber): gs://${du.bucket}/${name}\n`); continue; }
        if (live(b, name) && !G.check(c.w, c.as(), 'storage.objects.delete', bucketRes(b, du.bucket)).ok) throw httpErr(403, `${c.as()} does not have storage.objects.delete access to the Google Cloud Storage object. Permission 'storage.objects.delete' denied on resource (or it may not exist).`);
        c.err(`Copying ${fromTxt} to gs://${du.bucket}/${name}\n`);
        putObject(c, b, du.bucket, name, it.data, { ctype: c.a['content-type'], cls: c.a['storage-class'] && c.a['storage-class'].toUpperCase(), meta: c.a['custom-metadata'] ? Object.fromEntries(c.a['custom-metadata'].split(',').map((kv) => kv.split('='))) : undefined, ifNotExist: !!c.a['if-generation-match'] && c.a['if-generation-match'] === '0' });
      } else {
        let path = dst;
        if (dst === '-') { c.out(it.data); continue; }
        if (G.fs.isDir(c.sys, dst)) path = dst.replace(/\/$/, '') + '/' + it.rel;
        else if (many) throw E.plain(`Destination URL must name an existing directory if source URL contains multiple items: ${dst}`);
        const dir = G.fs.norm(c.sys, path).replace(/\/[^/]*$/, '');
        if (!G.fs.isDir(c.sys, dir)) { const parts = dir.split('/').filter(Boolean); for (let j = 1; j <= parts.length; j++) G.fs.mkdir(c.sys, '/' + parts.slice(0, j).join('/')); }
        c.err(`Copying ${fromTxt} to file://${G.fs.norm(c.sys, path)}\n`);
        G.fs.write(c.sys, path, it.data);
      }
      if (mv && it.gs) { const b = S(c.w).buckets[it.bucket]; delObject(c, b, it.name); c.err(`Removing ${it.gs}...\n`); }
      if (mv && it.local && it.local !== '-') delete c.sys.sh.files[G.fs.norm(c.sys, it.local)];
      n++; total += bytes(it.data);
    }
    c.err(`  Completed files ${n}/${items.length} | ${humanB(total)}/${humanB(total)}\n`);
  }
  const cpFlags = { r: 'b', R: 'b', recursive: 'b', 'no-clobber': 'b', n: 'b', 'content-type': 'v', 'storage-class': 'v', 'custom-metadata': 'v', 'if-generation-match': 'v' };
  G.gc('storage cp', { pos: ['SOURCE …', 'DESTINATION'], flags: cpFlags, run: async (c) => { if (c.a.n) c.a['no-clobber'] = true; await copy(c, false); } });
  G.gc('storage mv', { pos: ['SOURCE …', 'DESTINATION'], flags: cpFlags, run: async (c) => { await copy(c, true); } });
  G.gc('storage cat', { pos: ['URL …'], flags: { r: 'v', range: 'v' }, run: async (c) => {
    for (const url of c.p) {
      const u = parseUrl(url);
      if (!u) throw E.plain(`cat only works for valid cloud URLs. ${url} is an invalid cloud URL.`);
      const items = await readSrc(c, url);
      for (const it of items) c.out(it.data);
    }
  } });
  G.gc('storage rm', { pos: ['URLS …'], flags: { r: 'b', recursive: 'b', a: 'b', 'all-versions': 'b', 'continue-on-error': 'b' }, run: async (c) => {
    const rec = c.a.r || c.a.recursive, all = c.a.a || c.a['all-versions'];
    let n = 0;
    c.err('');
    for (const url of c.p) {
      const u = parseUrl(url);
      if (!u) throw E.plain(`rm only works for valid cloud URLs. ${url} is an invalid cloud URL.`);
      const b = getBucket(c, u.bucket, 'storage.objects.delete', { obj: u.obj, verb: 'DELETE' });
      let names = u.obj === '' && rec ? Object.keys(b.objects).sort() : /[*?]/.test(u.obj) ? expandObjects(b, u.obj, all) : (b.objects[u.obj] ? [u.obj] : []);
      if (rec && u.obj && !b.objects[u.obj]) names = Object.keys(b.objects).filter((x) => x.startsWith(u.obj.replace(/\/?$/, '/'))).sort();
      if (u.gen) {
        if (!delObject(c, b, u.obj, u.gen)) throw E.plain(`The following URLs matched no objects or files:\n-${url}`);
        c.err(`Removing objects:\nRemoving ${url}...\n`); n++; continue;
      }
      if (!names.length && !(u.obj === '' && rec)) throw E.plain(`The following URLs matched no objects or files:\n-${url}`);
      if (n === 0) c.err('Removing objects:\n');
      for (const nm of names) {
        const gens = (b.objects[nm] || []).slice();
        if (all || rec && all) { for (const g of gens) { c.err(`Removing gs://${u.bucket}/${nm}#${g.gen}...\n`); delObject(c, b, nm, g.gen); n++; } }
        else if (live(b, nm)) { c.err(`Removing gs://${u.bucket}/${nm}...\n`); delObject(c, b, nm); n++; }
      }
      if (u.obj === '' && rec) {
        // バケットごと消す
        if (Object.keys(b.objects).length && !all) { /* 古い世代が残っていれば、バケットは消せない */ }
        if (!Object.keys(b.objects).length) { c.err(`Removing Buckets:\nRemoving gs://${u.bucket}/...\n`); delete S(c.w).buckets[u.bucket]; }
        else throw httpErr(409, 'The bucket you tried to delete is not empty.');
      }
    }
    c.err(`  Completed ${n}/${n}\n`);
  } });
  G.gc('storage objects describe', { pos: ['URL'], fmt: 'yaml', run: async (c) => {
    const u = parseUrl(c.p[0]);
    const b = getBucket(c, u.bucket, 'storage.objects.get', { obj: u.obj });
    const g = u.gen ? (b.objects[u.obj] || []).find((x) => String(x.gen) === u.gen) : live(b, u.obj);
    if (!g) throw httpErr(404, `gs://${u.bucket}/${u.obj} not found: 404.`, true);
    return objView(b, u.bucket, u.obj, g);
  } });
  G.gc('storage objects list', { pos: ['URLS …'], fmt: 'yaml', run: async (c) => {
    const out = [];
    for (const url of c.p) {
      const u = parseUrl(url);
      const b = getBucket(c, u.bucket, 'storage.objects.list');
      const names = u.obj ? expandObjects(b, /[*?]/.test(u.obj) ? u.obj : u.obj + '**') : Object.keys(b.objects).filter((n) => live(b, n)).sort();
      for (const n of names) out.push(objView(b, u.bucket, n, live(b, n)));
    }
    return out;
  } });
  G.gc('storage objects update', { pos: ['URL …'], flags: { 'storage-class': 'v', 'content-type': 'v', 'custom-metadata': 'v' }, run: async (c) => {
    for (const url of c.p) {
      const u = parseUrl(url);
      const b = getBucket(c, u.bucket, 'storage.objects.update', { obj: u.obj, verb: 'PATCH' });
      const g = live(b, u.obj);
      if (!g) throw E.plain(`The following URLs matched no objects or files:\n-${url}`);
      c.err(`Patching ${url}#${g.gen}...\n`);
      if (c.a['storage-class']) { const cls = c.a['storage-class'].toUpperCase(); g.cls = cls; /* 本物はクラスを変えると書き直し（新しい世代） */ }
      if (c.a['content-type']) g.ctype = c.a['content-type'];
      c.err('  Completed 1/1\n');
    }
  } });
  G.gc('storage du', { pos: ['[URL …]'], flags: { s: 'b', summarize: 'b', r: 'b', 'readable-sizes': 'b' }, run: async (c) => {
    for (const url of c.p) {
      const u = parseUrl(url);
      const b = getBucket(c, u.bucket, 'storage.objects.list');
      const names = Object.keys(b.objects).filter((n) => live(b, n) && n.startsWith(u.obj)).sort();
      const fmt = (n) => (c.a['readable-sizes'] || c.a.r ? humanL(n) : String(n));
      if (c.a.s || c.a.summarize) { c.out(`${fmt(names.reduce((s, n) => s + live(b, n).size, 0))}  gs://${u.bucket}${u.obj ? '/' + u.obj : ''}\n`); continue; }
      for (const n of names) c.out(`${fmt(live(b, n).size)}  gs://${u.bucket}/${n}\n`);
    }
  } });

  // ---------------------------------------------------------------- ライフサイクル（時間が進んだときに判定する。1 日 1 回）
  G.TICK_HOOKS = G.TICK_HOOKS || [];
  G.TICK_HOOKS.push((w, from, to) => {
    const DAY = 86400000;
    const days = Math.floor(to / DAY) - Math.floor(from / DAY);
    if (days <= 0) return;
    for (const [name, b] of Object.entries(S(w).buckets)) {
      if (!b.lifecycle) continue;
      for (const [on, gens] of Object.entries(b.objects)) {
        for (const g of gens.slice()) {
          const age = Math.floor((to - g.created) / DAY);
          for (const r of b.lifecycle) {
            const cond = r.condition || {};
            if (cond.age !== undefined && age < cond.age) continue;
            if (cond.isLive !== undefined && cond.isLive !== g.live) continue;
            if (cond.matchesStorageClass && !cond.matchesStorageClass.includes(g.cls)) continue;
            if (cond.matchesPrefix && !cond.matchesPrefix.some((p) => on.startsWith(p))) continue;
            if (cond.numNewerVersions !== undefined) { const newer = gens.filter((x) => x.gen > g.gen).length; if (newer < cond.numNewerVersions) continue; }
            if (r.action.type === 'Delete') { if (g.live && b.versioning) { g.live = false; g.noncurrent = to; } else gens.splice(gens.indexOf(g), 1); break; }
            if (r.action.type === 'SetStorageClass') g.cls = r.action.storageClass;
          }
        }
        if (!gens.length) delete b.objects[on];
      }
    }
  });

  // ---------------------------------------------------------------- https://storage.googleapis.com/バケット/オブジェクト
  G.ROUTES.push({
    name: 'gcs',
    match: (w, u) => u.hostname === 'storage.googleapis.com' || /\.storage\.googleapis\.com$/.test(u.hostname) || u.hostname === 'storage.cloud.google.com',
    handle: (sys, req, u) => {
      const w = sys.w;
      const bearer = G.bearer(w, req);
      const xml = (status, code, msg, details) => ({ status, headers: { 'content-type': 'application/xml; charset=UTF-8' }, body: `<?xml version='1.0' encoding='UTF-8'?><Error><Code>${code}</Code><Message>${msg}</Message>${details ? `<Details>${details}</Details>` : ''}</Error>` });
      // JSON API：/storage/v1/b/バケット/o
      let m = u.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/?$/);
      if (m) {
        const b = S(w).buckets[m[1]];
        if (!bearer.who && !(b && G.check(w, null, 'storage.objects.list', bucketRes(b, m[1])).ok)) return G.json(401, { error: { code: 401, message: 'Anonymous caller does not have storage.objects.list access to the Google Cloud Storage bucket. Permission \'storage.objects.list\' denied on resource (or it may not exist).', errors: [{ message: 'Anonymous caller does not have storage.objects.list access to the Google Cloud Storage bucket. Permission \'storage.objects.list\' denied on resource (or it may not exist).', domain: 'global', reason: 'required', locationType: 'header', location: 'Authorization' }] } });
        if (!b) return G.json(404, { error: { code: 404, message: 'The specified bucket does not exist.', errors: [{ message: 'The specified bucket does not exist.', domain: 'global', reason: 'notFound' }] } });
        if (!G.check(w, bearer.who, 'storage.objects.list', bucketRes(b, m[1])).ok) return G.json(403, { error: { code: 403, message: `${bearer.who || 'Anonymous caller'} does not have storage.objects.list access to the Google Cloud Storage bucket. Permission 'storage.objects.list' denied on resource (or it may not exist).` } });
        const items = Object.keys(b.objects).filter((n) => live(b, n)).sort().map((n) => { const g = live(b, n); return { kind: 'storage#object', name: n, bucket: m[1], generation: String(g.gen), contentType: g.ctype, size: String(g.size), storageClass: g.cls, timeCreated: G.iso(g.created) }; });
        return G.json(200, { kind: 'storage#objects', items });
      }
      let bname, oname;
      if (u.hostname === 'storage.googleapis.com' || u.hostname === 'storage.cloud.google.com') { const parts = u.pathname.slice(1).split('/'); bname = parts[0]; oname = decodeURIComponent(parts.slice(1).join('/')); }
      else { bname = u.hostname.replace(/\.storage\.googleapis\.com$/, ''); oname = decodeURIComponent(u.pathname.slice(1)); }
      const b = S(w).buckets[bname];
      if (!b) return xml(404, 'NoSuchBucket', 'The specified bucket does not exist.');
      if (!oname) {
        if (!G.check(w, bearer.who, 'storage.objects.list', bucketRes(b, bname)).ok) return xml(bearer.who ? 403 : 401, 'AccessDenied', 'Access denied.', `${bearer.who || 'Anonymous caller'} does not have storage.objects.list access to the Google Cloud Storage bucket. Permission 'storage.objects.list' denied on resource (or it may not exist).`);
        const names = Object.keys(b.objects).filter((n) => live(b, n)).sort();
        return { status: 200, headers: { 'content-type': 'application/xml; charset=UTF-8' }, body: `<?xml version='1.0' encoding='UTF-8'?><ListBucketResult xmlns='http://doc.s3.amazonaws.com/2006-03-01'><Name>${bname}</Name>${names.map((n) => `<Contents><Key>${n}</Key><Size>${live(b, n).size}</Size></Contents>`).join('')}</ListBucketResult>` };
      }
      const g = live(b, oname);
      const papOn = b.pap === 'enforced' || G.orgPolicyOf(w, 'projects/' + b.project, 'storage.publicAccessPrevention');
      if (papOn && (!bearer.who || !G.check({ ...w, policies: Object.fromEntries(Object.entries(w.policies).map(([k, v]) => [k, { ...v, bindings: v.bindings.map((x) => ({ ...x, members: x.members.filter((m) => m !== 'allUsers' && m !== 'allAuthenticatedUsers') })) }])) }, bearer.who, 'storage.objects.get', bucketRes(b, bname)).ok)) return xml(403, 'AccessDenied', 'Access denied.', `${bearer.who || 'Anonymous caller'} does not have storage.objects.get access to the Google Cloud Storage object. Permission 'storage.objects.get' denied on resource (or it may not exist).`);
      if (!G.check(w, bearer.who, 'storage.objects.get', bucketRes(b, bname)).ok) return xml(bearer.who ? 403 : 403, 'AccessDenied', 'Access denied.', `${bearer.who || 'Anonymous caller'} does not have storage.objects.get access to the Google Cloud Storage object. Permission 'storage.objects.get' denied on resource (or it may not exist).`);
      if (!g) return xml(404, 'NoSuchKey', 'The specified key does not exist.', `No such object: ${bname}/${oname}`);
      return { status: 200, headers: { 'content-type': g.ctype, 'x-goog-generation': String(g.gen), 'x-goog-storage-class': g.cls, 'cache-control': b.pap !== 'enforced' && G.check(w, null, 'storage.objects.get', bucketRes(b, bname)).ok ? 'public, max-age=3600' : 'private, max-age=0' }, body: g.data };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
