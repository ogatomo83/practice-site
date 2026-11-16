// Artifact Registry、Cloud Build、Cloud Run、Cloud Run functions。コンテナの中身は「イメージの種類」：
//   { kind: 'builtin', name: 'hello' | 'hello-app' | 'nginx', ver } … 公開されているサンプルのイメージ
//   { kind: 'node', files: { 'server.js': …, 'package.json': … }, main, env, port } … 読者のソース（jsrt.js で動かす）
//   { kind: 'function', files, entry, signature } … Functions Framework で包んだ関数
// インスタンスはページの中に持つ（world には入れない）。15 分使われなければ、次の要求でコールドスタートする。
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.run = () => ({ services: {} });
  G.SERVICES_INIT.ar = () => ({ repos: {} });
  G.SERVICES_INIT.build = () => ({ builds: [] });
  G.SERVICES_INIT.fn = () => ({ functions: {} });
  const R = (w) => w.svc.run, A = (w) => w.svc.ar, F = (w) => w.svc.fn;
  const RUN_REGIONS = G.REGIONS.map((r) => r[0]);

  // ---------------------------------------------------------------- 出来事の列（Pub/Sub の配信、関数のトリガー）
  // コマンドが終わるたびに Sys.run が G.drain を呼ぶ
  G.emit = (w, ev) => { (w.pending = w.pending || []).push(ev); };
  G.EVENT_HANDLERS = G.EVENT_HANDLERS || {};
  G.drain = async (sys) => {
    for (let round = 0; round < 8; round++) {
      const list = sys.w.pending || [];
      if (!list.length) return;
      sys.w.pending = [];
      for (const ev of list) { const h = G.EVENT_HANDLERS[ev.kind]; if (h) await h(sys, ev); }
    }
  };

  // ---------------------------------------------------------------- イメージ
  const BUILTIN = {
    'us-docker.pkg.dev/cloudrun/container/hello': { kind: 'builtin', name: 'hello', port: 8080 },
    'gcr.io/cloudrun/hello': { kind: 'builtin', name: 'hello', port: 8080 },
    'gcr.io/google-samples/hello-app:1.0': { kind: 'builtin', name: 'hello-app', ver: '1.0.0', port: 8080 },
    'gcr.io/google-samples/hello-app:2.0': { kind: 'builtin', name: 'hello-app', ver: '2.0.0', port: 8080 },
    'nginx': { kind: 'builtin', name: 'nginx', port: 80 }, 'nginx:latest': { kind: 'builtin', name: 'nginx', port: 80 }, 'docker.io/library/nginx': { kind: 'builtin', name: 'nginx', port: 80 },
  };
  const digestOf = (s) => 'sha256:' + G.hex('dig' + s, 64);
  // イメージの名前 → { app, digest, ref } または例外
  function resolveImage(w, ref) {
    const r0 = ref.replace(/:latest$/, '');
    if (BUILTIN[ref] || BUILTIN[r0]) return { app: BUILTIN[ref] || BUILTIN[r0], digest: digestOf(ref), ref };
    const m = ref.match(/^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/([^:@]+)(?::([\w.-]+)|@(sha256:[0-9a-f]+))?$/);
    if (!m) throw E.plain(`Image '${ref}' not found.`);
    const [, loc, proj, repo, img, tag, dg] = m;
    const rp = A(w).repos[`${proj}/${loc}/${repo}`];
    const im = rp && rp.images[img];
    const digest = im && (dg ? (im.digests[dg] ? dg : null) : im.tags[tag || 'latest']);
    if (!digest) throw E.plain(`Image '${ref}' not found.`);
    return { app: im.digests[digest].app, digest, ref, project: proj };
  }

  // ---------------------------------------------------------------- Artifact Registry
  const repoView = (r) => ({ createTime: G.iso(r.created, 6), description: r.desc || undefined, format: r.format, mode: 'STANDARD_REPOSITORY', name: `projects/${r.project}/locations/${r.loc}/repositories/${r.name}`, sizeBytes: String(Object.values(r.images).reduce((n, im) => n + Object.keys(im.digests).length * 41982377, 0)), updateTime: G.iso(r.updated || r.created, 6) });
  G.gc('artifacts repositories create', { pos: ['REPOSITORY'], flags: { 'repository-format': 'v', location: 'v', description: 'v', async: 'b' }, req: ['repository-format'], run: async (c) => {
    const pid = c.need();
    const loc = c.a.location || G.cfgGet(c.w, 'artifacts/location');
    if (!loc) throw E.usage('Missing required argument [--location]: The location of the repository. Overrides the default artifacts/location property value for this command invocation.');
    c.call({ method: 'google.devtools.artifactregistry.v1.ArtifactRegistry.CreateRepository', perm: 'artifactregistry.repositories.create', res: 'projects/' + pid, svc: 'artifactregistry.googleapis.com', project: pid, resType: 'audited_resource' });
    const k = `${pid}/${loc}/${c.p[0]}`;
    if (A(c.w).repos[k]) throw new G.Err(409, 'ALREADY_EXISTS', `the repository already exists`);
    A(c.w).repos[k] = { project: pid, loc, name: c.p[0], format: c.a['repository-format'].toUpperCase(), desc: c.a.description, created: c.w.t, images: {} };
    G.tick(c.w, 4000);
    c.err(`Create request issued for: [${c.p[0]}]\nWaiting for operation [projects/${pid}/locations/${loc}/operations/${G.uuid('arop' + k)}] to complete...done.\nCreated repository [${c.p[0]}].\n`);
  } });
  G.gc('artifacts repositories list', { flags: { location: 'v' }, fmt: 'table(name.basename():label=REPOSITORY, format, mode, description, name.segment(3):label=LOCATION, labels, kmsKeyName:label=ENCRYPTION, createTime, updateTime, sizeBytes:label="SIZE (MB)")', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListRepositories', perm: 'artifactregistry.repositories.list', res: 'projects/' + pid, svc: 'artifactregistry.googleapis.com', project: pid, read: true });
    c.err(`Listing items under project ${pid}, across all locations.\n\n`);
    return Object.values(A(c.w).repos).filter((r) => r.project === pid && (!c.a.location || r.loc === c.a.location)).map((r) => Object.assign(repoView(r), { kmsKeyName: 'Google-managed key', sizeBytes: (Number(repoView(r).sizeBytes) / 1048576).toFixed(3) }));
  } });
  G.gc('artifacts docker images list', { pos: ['IMAGE_PATH'], flags: { 'include-tags': 'b' }, fmt: 'table(package:label=IMAGE, version.basename():label=DIGEST, createTime.date("%Y-%m-%dT%H:%M:%S"):label=CREATE_TIME, updateTime.date("%Y-%m-%dT%H:%M:%S"):label=UPDATE_TIME, tags.join(","):label=TAGS)', run: async (c) => {
    const m = c.p[0].match(/^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)(?:\/(.+))?$/);
    if (!m) throw E.plain(`Invalid image path ${c.p[0]}`);
    const rp = A(c.w).repos[`${m[2]}/${m[1]}/${m[3]}`];
    c.call({ method: 'ListDockerImages', perm: 'artifactregistry.dockerimages.list', res: 'projects/' + m[2], svc: 'artifactregistry.googleapis.com', project: m[2], read: true });
    if (!rp) throw new G.Err(404, 'NOT_FOUND', `Requested entity was not found.`);
    c.err(`Listing items under project ${m[2]}, location ${m[1]}, repository ${m[3]}.\n\n`);
    const rows = [];
    for (const [img, im] of Object.entries(rp.images)) {
      if (m[4] && img !== m[4]) continue;
      for (const [dg, d] of Object.entries(im.digests)) rows.push({ package: `${m[1]}-docker.pkg.dev/${m[2]}/${m[3]}/${img}`, version: dg, createTime: G.iso(d.created), updateTime: G.iso(d.created), tags: Object.keys(im.tags).filter((t) => im.tags[t] === dg) });
    }
    if (!c.a['include-tags']) for (const r of rows) delete r.tags;
    return rows;
  } });
  function pushImage(c, ref, app) {
    const m = ref.match(/^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/([^:@]+)(?::([\w.-]+))?$/);
    if (!m) throw E.plain(`invalid image name: ${ref}（Artifact Registry の名前は「場所-docker.pkg.dev/プロジェクト/リポジトリ/イメージ:タグ」です）`);
    const rp = A(c.w).repos[`${m[2]}/${m[1]}/${m[3]}`];
    if (!rp) return `name unknown: Repository "${m[3]}" not found`;
    const im = rp.images[m[4]] = rp.images[m[4]] || { tags: {}, digests: {} };
    const dg = digestOf(JSON.stringify(app) + c.w.t);
    im.digests[dg] = { app, created: c.w.t };
    for (const t of Object.keys(im.tags)) if (t === (m[5] || 'latest')) delete im.tags[t];
    im.tags[m[5] || 'latest'] = dg;
    rp.updated = c.w.t;
    return { digest: dg, ref: `${m[1]}-docker.pkg.dev/${m[2]}/${m[3]}/${m[4]}` };
  }

  // ---------------------------------------------------------------- Cloud Build（Dockerfile かビルドパック）
  // ソースのディレクトリ → アプリ。Dockerfile があれば FROM / ENV / CMD / EXPOSE を読む。なければ package.json（ビルドパック）
  function buildApp(c, files) {
    const df = files['Dockerfile'];
    const log = [];
    const env = {};
    let main = null, port = null, base = null;
    if (df !== undefined) {
      const lines = df.split('\n');
      let step = 0;
      const steps = lines.filter((l) => /^\s*[A-Z]+\s/.test(l));
      for (const l of steps) {
        const m = l.trim().match(/^([A-Z]+)\s+(.*)$/);
        step++;
        log.push(`Step ${step}/${steps.length} : ${m[1]} ${m[2]}`);
        if (m[1] === 'FROM') { base = m[2].split(/\s+/)[0]; if (BUILTIN[base] || BUILTIN[base.replace(/:latest$/, '')]) { const b = BUILTIN[base] || BUILTIN[base.replace(/:latest$/, '')]; return { app: Object.assign({}, b, { env }), log }; } if (!/^node(:|$)/.test(base)) throw E.plain(`このサイトの Cloud Build は、FROM が node:… か、サンプルのイメージ（nginx など）の Dockerfile だけを組み立てられます：${base}`); log.push(` ---> ${G.hex('img' + base, 12)}`); }
        else if (m[1] === 'ENV') { const kv = m[2].match(/^(\w+)[= ](.*)$/); if (kv) env[kv[1]] = kv[2].replace(/^"|"$/g, ''); }
        else if (m[1] === 'EXPOSE') port = Number(m[2]);
        else if (m[1] === 'CMD' || m[1] === 'ENTRYPOINT') { let a; try { a = JSON.parse(m[2]); } catch (e) { a = m[2].split(/\s+/); } if (a[0] === 'node') main = a[1]; else if (a[0] === 'npm' && a[1] === 'start') main = null; }
        else if (m[1] === 'RUN') log.push(' ---> Running in ' + G.hex('run' + l, 12));
      }
    } else if (files['package.json'] === undefined) {
      throw E.plain('ビルドに失敗しました：Dockerfile も package.json もありません（このサイトのビルドパックは Node.js のソースだけを組み立てます）');
    }
    let pkg = {};
    if (files['package.json'] !== undefined) { try { pkg = JSON.parse(files['package.json']); } catch (e) { throw E.plain(`ビルドに失敗しました：package.json が JSON として読めません（${e.message}）`); } }
    if (!main) { const st = pkg.scripts && pkg.scripts.start; main = st ? (st.match(/^node\s+(\S+)/) || [])[1] : null; main = main || pkg.main || 'index.js'; }
    if (files[main] === undefined) log.push(`warning: ${main} が見つかりません`);
    return { app: { kind: 'node', files: Object.assign({}, files), main, env, port }, log };
  }
  G.gc('builds submit', { pos: ['[SOURCE]'], flags: { tag: 'v', t: 'v', config: 'v', region: 'v', async: 'b', pack: 'v', 'service-account': 'v' }, run: async (c) => {
    if (c.a.t) c.a.tag = c.a.t;
    const pid = c.need();
    c.call({ method: 'google.devtools.cloudbuild.v1.CloudBuild.CreateBuild', perm: 'cloudbuild.builds.create', res: 'projects/' + pid, svc: 'cloudbuild.googleapis.com', project: pid, billable: true });
    const p = c.w.projects[pid];
    if (!c.a.tag && !c.a.pack) throw E.plain('このサイトの gcloud builds submit は、--tag=イメージの名前 の使い方だけに対応しています（cloudbuild.yaml は読みません）。');
    const dir = c.p[0] || '.';
    if (!G.fs.isDir(c.sys, dir)) throw E.plain(`could not find source [${dir}]`);
    const files = G.fs.tree(c.sys, dir);
    const n = Object.keys(files).length;
    const size = Object.values(files).reduce((s, x) => s + new TextEncoder().encode(x).length, 0);
    const id = G.uuid('build' + G.seq(c.w, 'build'));
    const bucket = `${pid}_cloudbuild`;
    if (!G.gcsBucket(c.w, bucket)) {
      c.w.svc.storage.buckets[bucket] = { project: pid, location: 'US', locationType: 'multi-region', cls: 'STANDARD', created: c.w.t, updated: c.w.t, versioning: false, ubla: false, pap: 'inherited', labels: {}, lifecycle: null, metageneration: 1, objects: {} };
    }
    const tgz = `source/${Math.floor((G.T0 + c.w.t) / 1000)}.${String(c.w.t % 1000).padStart(6, '0')}-${G.hex(id, 32)}.tgz`;
    G.gcsPut(c.w, bucket, tgz, '(tgz)');
    c.err(`Creating temporary archive of ${n} file(s) totalling ${size < 1024 ? size + ' bytes' : (size / 1024).toFixed(1) + ' KiB'} before compression.\nUploading tarball of [${dir}] to [gs://${bucket}/${tgz}]\nCreated [https://cloudbuild.googleapis.com/v1/projects/${pid}/locations/global/builds/${id}].\nLogs are available at [ https://console.cloud.google.com/cloud-build/builds/${id}?project=${p.projectNumber} ].\nWaiting for build to complete. Polling interval: 1 second(s).\n`);
    c.out('------------------------------------------------- REMOTE BUILD OUTPUT --------------------------------------------------\n');
    c.out(`starting build "${id}"\n\nFETCHSOURCE\nFetching storage object: gs://${bucket}/${tgz}#${Date.now() % 1}0\nBUILD\n`);
    let b;
    const rec = { id, project: pid, created: c.w.t, status: 'WORKING', images: [c.a.tag], source: `gs://${bucket}/${tgz}` };
    c.w.svc.build.builds.push(rec);
    try { b = buildApp(c, files); }
    catch (e) { rec.status = 'FAILURE'; c.out(String(e.message) + '\nERROR\n'); c.out('------------------------------------------------------------------------------------------------------------------------\n'); throw new G.Err(0, 'PLAIN', `build ${id} completed with status "FAILURE"`); }
    for (const l of b.log) c.out(l + '\n');
    c.out(`Successfully built ${G.hex('built' + id, 12)}\nSuccessfully tagged ${c.a.tag}\nPUSH\nPushing ${c.a.tag}\n`);
    const pr = pushImage(c, c.a.tag, b.app);
    G.tick(c.w, 45000);
    if (typeof pr === 'string') {
      rec.status = 'FAILURE';
      c.out(`${pr}\nERROR\nERROR: push attempt 1 detected failure, retrying: step exited with non-zero status: 1\n`);
      c.out('------------------------------------------------------------------------------------------------------------------------\n');
      throw new G.Err(0, 'PLAIN', `build ${id} completed with status "FAILURE"`);
    }
    rec.status = 'SUCCESS';
    rec.digest = pr.digest;
    c.out(`latest: digest: ${pr.digest} size: 1997\nDONE\n------------------------------------------------------------------------------------------------------------------------\n`);
    return [{ id, createTime: G.iso(rec.created), duration: '46S', source: rec.source, images: [c.a.tag], status: 'SUCCESS' }];
  }, fmt: 'table(id, createTime.date("%Y-%m-%dT%H:%M:%S+00:00"):label=CREATE_TIME, duration, source, images.join(","):label=IMAGES, status)' });
  G.gc('builds list', { flags: { region: 'v', limit: 'v' }, fmt: 'table(id, createTime.date("%Y-%m-%dT%H:%M:%S+00:00"):label=CREATE_TIME, duration, source, images.join(","):label=IMAGES, status)', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListBuilds', perm: 'cloudbuild.builds.list', res: 'projects/' + pid, svc: 'cloudbuild.googleapis.com', project: pid, read: true });
    return c.w.svc.build.builds.filter((b) => b.project === pid).slice().reverse().map((b) => ({ id: b.id, createTime: G.iso(b.created), duration: '46S', source: b.source, images: b.images, status: b.status }));
  } });

  // ---------------------------------------------------------------- Cloud Run：サービスとリビジョン
  const svcKey = (pid, region, name) => `${pid}/${region}/${name}`;
  const svcRes = (s) => `projects/${s.project}/locations/${s.region}/services/${s.name}`;
  G.runUrl = (w, s) => `https://${s.name}-${w.projects[s.project].projectNumber}.${s.region}.run.app`;
  const regionArg = (c, kind = 'run') => {
    const r = c.a.region || G.cfgGet(c.w, kind + '/region');
    if (!r) throw E.plain(`Missing required argument [--region]: You must specify a region. Either use the \`--region\` flag or set the ${kind}/region property.`);
    if (!RUN_REGIONS.includes(r)) throw E.plain(`Invalid region: ${r}`);
    return r;
  };
  function getSvc(c, name, perm, kind) {
    const pid = c.need();
    const region = regionArg(c);
    const s = R(c.w).services[svcKey(pid, region, name)];
    c.call({ method: 'google.cloud.run.v1.Services.GetService', perm, res: s ? svcRes(s) : `projects/${pid}/locations/${region}/services/${name}`, svc: 'run.googleapis.com', project: pid, read: /get|list/.test(perm), resPretty: `namespaces/${pid}/services/${name}` });
    if (!s) throw new G.Err(404, 'NOT_FOUND', '', { gcloud: `Cannot find service [${name}]` });
    return s;
  }
  const revName = (w, s) => `${s.name}-${String(s.revs.length + 1).padStart(5, '0')}-${G.alnum('rev' + s.name + s.revs.length + w.t, 3)}`;
  // 新しいリビジョンを作って、起動できるか確かめる
  async function newRevision(c, s, o) {
    const prev = s.revs.filter((r) => !r.failed).pop() || s.revs[s.revs.length - 1];
    const rev = Object.assign({}, prev ? G.clone(prev) : { env: {}, sa: G.computeSa(c.w, s.project), port: 8080, cpu: '1000m', mem: '512Mi', concurrency: 80, max: 100, min: 0, timeout: 300, cloudsql: [], secrets: {} }, o);
    delete rev.failed;
    rev.name = o.revSuffix ? `${s.name}-${o.revSuffix}` : revName(c.w, s);
    rev.created = c.w.t; rev.by = c.as();
    const img = resolveImage(c.w, rev.image);
    rev.digest = img.digest;
    rev.app = img.app;
    // 起動の確認（コンテナが PORT で待ち受けるか）
    const probe = await startInstance(c.sys, s, rev, true);
    if (!probe.ok) {
      const logUrl = `https://console.cloud.google.com/logs/viewer?project=${s.project}&resource=cloud_run_revision/service_name/${s.name}/revision_name/${rev.name}&advancedFilter=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22${s.name}%22%0Aresource.labels.revision_name%3D%22${rev.name}%22`;
      rev.failed = true;
      s.revs.push(rev);
      return { error: `Revision '${rev.name}' is not ready and cannot serve traffic. ${probe.reason}\n\nLogs URL: ${logUrl} \nFor more troubleshooting guidance, see https://cloud.google.com/run/docs/troubleshooting#container-failed-to-start`, rev };
    }
    s.revs.push(rev);
    return { rev };
  }
  const envArgs = (s) => { const o = {}; for (const kv of G.fmtSplit(s || '')) { const k = kv.indexOf('='); if (k > 0) o[kv.slice(0, k)] = kv.slice(k + 1); } return o; };
  const DEPLOY_FLAGS = {
    image: 'v', source: 'v', region: 'v', 'allow-unauthenticated': 'b', 'set-env-vars': 'v', 'update-env-vars': 'v', 'remove-env-vars': 'v', 'clear-env-vars': 'b', 'service-account': 'v', port: 'v',
    memory: 'v', cpu: 'v', concurrency: 'v', 'min-instances': 'v', 'max-instances': 'v', timeout: 'v', tag: 'v', 'no-traffic': 'b', ingress: 'v', 'add-cloudsql-instances': 'v', 'set-cloudsql-instances': 'v', platform: 'v', 'revision-suffix': 'v',
    function: 'v', 'base-image': 'v', 'set-secrets': 'v', 'update-secrets': 'v', labels: 'v', 'no-cpu-throttling': 'b', 'cpu-boost': 'b', 'execution-environment': 'v', async: 'b', 'invoker-iam-check': 'b',
  };
  function applyFlags(c, o, prev) {
    if (c.a['set-env-vars'] !== undefined) o.env = envArgs(c.a['set-env-vars']);
    if (c.a['update-env-vars']) o.env = Object.assign({}, prev ? prev.env : {}, o.env || {}, envArgs(c.a['update-env-vars']));
    if (c.a['remove-env-vars']) { o.env = Object.assign({}, prev ? prev.env : {}); for (const k of c.a['remove-env-vars'].split(',')) delete o.env[k]; }
    if (c.a['clear-env-vars']) o.env = {};
    for (const k of Object.keys(o.env || {})) if (/^(PORT|K_SERVICE|K_REVISION|K_CONFIGURATION)$/.test(k)) throw E.plain(`The following reserved env names were provided: ${k}. These values are automatically set by the system.`);
    if (c.a['service-account']) {
      const f = G.findSa(c.w, c.a['service-account']);
      if (!f) throw new G.Err(400, '', '', { gcloud: `Service account ${c.a['service-account']} does not exist.` });
      if (!G.check(c.w, c.as(), 'iam.serviceAccounts.actAs', `projects/${f.project}/serviceAccounts/${f.sa.email}`).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'iam.serviceaccounts.actAs' denied on service account ${f.sa.email} (or it may not exist).` });
      o.sa = f.sa.email;
    }
    if (c.a.port) o.port = Number(c.a.port);
    if (c.a.memory) o.mem = c.a.memory;
    if (c.a.cpu) o.cpu = /m$/.test(c.a.cpu) ? c.a.cpu : `${Number(c.a.cpu) * 1000}m`;
    if (c.a.concurrency) o.concurrency = Number(c.a.concurrency);
    if (c.a['min-instances'] !== undefined) o.min = Number(c.a['min-instances']);
    if (c.a['max-instances'] !== undefined) o.max = Number(c.a['max-instances']);
    if (c.a.timeout) o.timeout = parseInt(c.a.timeout, 10);
    if (c.a['add-cloudsql-instances']) o.cloudsql = (prev ? prev.cloudsql : []).concat(c.a['add-cloudsql-instances'].split(','));
    if (c.a['set-cloudsql-instances'] !== undefined) o.cloudsql = c.a['set-cloudsql-instances'].split(',').filter(Boolean);
    return o;
  }
  // 公開（allUsers に run.invoker）を付ける・聞く
  function setInvoker(c, s) {
    const res = svcRes(s);
    if (c.a['allow-unauthenticated'] === true) {
      try { G.addBinding(c, res, 'service', s.name, 'allUsers', 'roles/run.invoker', null); }
      catch (e) { c.err(`WARNING: Setting IAM policy failed, try "gcloud beta run services add-iam-policy-binding --region=${s.region} --member=allUsers --role=roles/run.invoker ${s.name}"\n`); return false; }
      return true;
    }
    if (c.a['allow-unauthenticated'] === false) {
      const pol = c.w.policies[res];
      if (pol) for (const b of pol.bindings) if (b.role === 'roles/run.invoker') b.members = b.members.filter((m) => m !== 'allUsers');
    }
    return null;
  }
  async function deploy(c, opts = {}) {
    const pid = c.need();
    const region = regionArg(c);
    const name = c.p[0] || (c.a.function ? c.a.function.toLowerCase() : null);
    if (!name) throw E.plain('Missing required argument [SERVICE]: Service name or resource URI');
    if (!/^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$/.test(name)) throw E.plain(`service name must use only lowercase alphanumeric characters and dashes. Cannot begin or end with a dash, and cannot be longer than 49 characters.`);
    const k = svcKey(pid, region, name);
    let s = R(c.w).services[k];
    const isNew = !s;
    c.call({ method: isNew ? 'google.cloud.run.v1.Services.CreateService' : 'google.cloud.run.v1.Services.ReplaceService', perm: isNew ? 'run.services.create' : 'run.services.update', res: isNew ? `projects/${pid}/locations/${region}` : svcRes(s), svc: 'run.googleapis.com', project: pid, billable: true, resType: 'cloud_run_revision', resLabels: { service_name: name, location: region },
      deniedMsg: () => `Permission '${isNew ? 'run.services.create' : 'run.services.update'}' denied on resource 'namespaces/${pid}/services/${name}' (or resource may not exist).` });
    const prev = s ? s.revs.filter((r) => !r.failed).pop() : null;
    let image = c.a.image || (prev && !c.a.source && !opts.source ? prev.image : null);
    let built = null;
    if (c.a.source || opts.source) {
      const dir = c.a.source || opts.source;
      if (!G.fs.isDir(c.sys, dir)) throw E.plain(`could not find source [${dir}]`);
      for (const api of ['cloudbuild.googleapis.com', 'artifactregistry.googleapis.com']) if (!c.w.projects[pid].services.includes(api)) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: ${G.APIS[api]} has not been used in project ${c.w.projects[pid].projectNumber} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${api}/overview?project=${c.w.projects[pid].projectNumber} then retry.` });
      const repoK = `${pid}/${region}/cloud-run-source-deploy`;
      if (!A(c.w).repos[repoK]) {
        c.err(`Deploying from source requires an Artifact Registry Docker repository to store built containers. A repository named [cloud-run-source-deploy] in region [${region}] will be created.\n\n`);
        c.confirm('');
        A(c.w).repos[repoK] = { project: pid, loc: region, name: 'cloud-run-source-deploy', format: 'DOCKER', desc: 'Cloud Run Source Deployments', created: c.w.t, images: {} };
      }
      const files = G.fs.tree(c.sys, dir);
      let b;
      if (c.a.function) {
        if (files['package.json'] === undefined && files['index.js'] === undefined) throw E.plain('関数のソース（index.js と package.json）が見つかりません');
        b = { app: { kind: 'function', files: Object.assign({}, files), entry: c.a.function, main: (JSON.parse(files['package.json'] || '{}').main) || 'index.js' } };
      } else b = buildApp(c, files);
      image = `${region}-docker.pkg.dev/${pid}/cloud-run-source-deploy/${name}`;
      built = pushImage(c, image + ':latest', b.app);
      image = `${built.ref}@${built.digest}`;
      G.tick(c.w, 60000);
    }
    if (!image) throw E.plain(`Missing required argument [--image]: Requires a container image to deploy (e.g. \`gcr.io/cloudrun/hello:latest\`) if no build source is provided.`);
    try { resolveImage(c.w, image); }
    catch (e) { throw new G.Err(0, 'PLAIN', `Revision '${name}-${String((s ? s.revs.length : 0) + 1).padStart(5, '0')}-${G.alnum('x' + name, 3)}' is not ready and cannot serve traffic. Image '${image}' not found.`); }
    const header = built ? `Building using ${c.a.function ? 'Buildpacks' : (G.fs.tree(c.sys, c.a.source || opts.source).Dockerfile !== undefined ? 'Dockerfile' : 'Buildpacks')} and deploying container to` : 'Deploying container to';
    c.err(`${header} Cloud Run service [${name}] in project [${pid}] region [${region}]\n`);
    if (isNew) {
      s = R(c.w).services[k] = { project: pid, region, name, revs: [], traffic: [{ latest: true, percent: 100 }], ingress: c.a.ingress || 'all', created: c.w.t, labels: {}, tags: {} };
      c.w.policies[svcRes(s)] = { version: 1, etag: 'BwY' + G.alnum('svc' + k, 9) + '=', bindings: [] };
    }
    if (c.a.ingress) s.ingress = c.a.ingress;
    const o = applyFlags(c, { image }, prev);
    if (!o.sa && !prev) { const sa = G.computeSa(c.w, pid); if (!G.check(c.w, c.as(), 'iam.serviceAccounts.actAs', `projects/${pid}/serviceAccounts/${sa}`).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'iam.serviceaccounts.actAs' denied on service account ${sa} (or it may not exist).` }); }
    if (c.a['revision-suffix']) o.revSuffix = c.a['revision-suffix'];
    const r = await newRevision(c, s, o);
    const steps = [built ? '  ✓ Uploading sources...' : null, built ? `  ✓ Building Container... Logs are available at [https://console.cloud.google.com/cloud-build/builds;region=${region}/${G.uuid('b' + name + c.w.t)}?project=${c.w.projects[pid].projectNumber}].` : null].filter(Boolean);
    if (r.error) {
      if (isNew) { /* サービスは残る（リビジョンが失敗した状態） */ }
      c.err(`${built ? 'X Building and deploying' : 'X Deploying'}${isNew ? ' new service' : ''}... ${r.error.split('\n')[0]}\n${steps.join('\n')}${steps.length ? '\n' : ''}  X Creating Revision... ${r.error.split('\n')[0]}\n  . Routing traffic...\n${isNew && c.a['allow-unauthenticated'] ? '  ✓ Setting IAM Policy...\n' : ''}Deployment failed\n`);
      if (isNew && c.a['allow-unauthenticated']) setInvoker(c, s);
      throw new G.Err(0, 'PLAIN', r.error);
    }
    // トラフィック
    if (c.a['no-traffic']) { if (isNew) throw E.plain('--no-traffic not supported when creating a new service.'); const lat = s.traffic.find((t) => t.latest); if (lat) { delete lat.latest; lat.rev = prev.name; } }
    if (c.a.tag) s.tags[c.a.tag] = r.rev.name;
    let iam = null;
    if (isNew || c.a['allow-unauthenticated'] !== undefined) {
      if (isNew && c.a['allow-unauthenticated'] === undefined) {
        c.err(`Allow unauthenticated invocations to [${name}] (y/N)?  \n\n`);
        const ans = (c.stdin || '').trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') c.a['allow-unauthenticated'] = true;
      }
      iam = setInvoker(c, s);
    }
    G.tick(c.w, 15000);
    c.err(`✓ ${built ? 'Building and deploying' : 'Deploying'}${isNew ? ' new service' : ''}... Done.\n${steps.join('\n')}${steps.length ? '\n' : ''}  ✓ Creating Revision...\n  ✓ Routing traffic...\n${iam ? '  ✓ Setting IAM Policy...\n' : ''}Done.\n`);
    const pct = trafficOf(s).filter((t) => t.rev === r.rev.name).reduce((n, t) => n + t.percent, 0);
    c.err(`Service [${name}] revision [${r.rev.name}] has been deployed and is serving ${pct} percent of traffic.\n`);
    if (c.a.tag) c.err(`The revision can be reached directly at https://${c.a.tag}---${name}-${c.w.projects[pid].projectNumber}.${region}.run.app\n`);
    c.err(`Service URL: ${G.runUrl(c.w, s)}\n`);
    G.audit(c.w, { project: pid, who: c.as(), method: isNew ? 'google.cloud.run.v1.Services.CreateService' : 'google.cloud.run.v1.Services.ReplaceService', perm: isNew ? 'run.services.create' : 'run.services.update', res: `namespaces/${pid}/services/${name}`, svc: 'run.googleapis.com', resType: 'cloud_run_revision', resLabels: { service_name: name, location: region } });
    return s;
  }
  G.runDeploy = deploy;
  G.gc('run deploy', { pos: ['[SERVICE]'], flags: DEPLOY_FLAGS, run: async (c) => { await deploy(c); } });
  // トラフィックの割り当て：[{ rev, percent, tag? }]（latest は今の最新のリビジョン）
  function trafficOf(s) {
    const latest = s.revs.filter((r) => !r.failed).pop();
    return s.traffic.map((t) => ({ rev: t.latest ? latest && latest.name : t.rev, percent: t.percent, latest: !!t.latest }));
  }
  G.gc('run services list', { flags: { region: 'v' }, fmt: 'table(status:label="", metadata.name:label=SERVICE, region:label=REGION, status_url:label=URL, last_by:label="LAST DEPLOYED BY", last_at:label="LAST DEPLOYED AT")', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.cloud.run.v1.Services.ListServices', perm: 'run.services.list', res: 'projects/' + pid, svc: 'run.googleapis.com', project: pid, read: true });
    return Object.values(R(c.w).services).filter((s) => s.project === pid && (!c.a.region || s.region === c.a.region)).sort((a, b) => (a.name < b.name ? -1 : 1)).map((s) => {
      const last = s.revs[s.revs.length - 1];
      const ok = s.revs.some((r) => !r.failed);
      return { status: ok ? '✔' : '✖', metadata: { name: s.name }, region: s.region, status_url: G.runUrl(c.w, s), last_by: last ? last.by : '', last_at: last ? G.iso(last.created, 6) : '' };
    });
  } });
  function describeText(c, s) {
    const tr = trafficOf(s);
    const last = s.revs[s.revs.length - 1];
    const ok = s.revs.filter((r) => !r.failed).pop() || last;
    const envs = Object.keys(ok.env || {}).sort();
    const pad = (k) => (k + ':').padEnd(17);
    const tags = Object.entries(s.tags || {});
    let t = `✔ Service ${s.name} in region ${s.region}\n \nURL:     ${G.runUrl(c.w, s)}\nIngress: ${s.ingress}\nTraffic:\n`;
    for (const x of tr) t += `  ${String(x.percent).padStart(3)}% ${x.latest ? `LATEST (currently ${x.rev})` : x.rev}\n`;
    for (const [tg, rv] of tags) t += `        ${rv}\n          ${tg}: https://${tg}---${s.name}-${c.w.projects[s.project].projectNumber}.${s.region}.run.app\n`;
    t += ` \nLast updated on ${G.iso(last.created, 6)} by ${last.by}:\n  Revision ${ok.name}\n  Container None\n    Image:           ${ok.image}\n    Port:            ${ok.port}\n    Memory:          ${ok.mem}\n    CPU:             ${ok.cpu}\n`;
    if (envs.length) t += `    Env vars:\n${envs.map((k) => `      ${k.padEnd(15)}${ok.env[k]}`).join('\n')}\n`;
    t += `    Startup Probe:\n      TCP every 240s\n      Port:          ${ok.port}\n      Initial delay: 0s\n      Timeout:       240s\n      Failure threshold: 1\n      Type:          Default\n  Service account:   ${ok.sa}\n  Concurrency:       ${ok.concurrency}\n${ok.min ? `  Min instances:     ${ok.min}\n` : ''}  Max instances:     ${ok.max}\n  Timeout:           ${ok.timeout}s\n`;
    if ((ok.cloudsql || []).length) t += `  Cloud SQL connections: ${ok.cloudsql.join(',')}\n`;
    return t;
  }
  const knative = (c, s) => {
    const ok = s.revs.filter((r) => !r.failed).pop() || s.revs[s.revs.length - 1];
    const p = c.w.projects[s.project];
    return {
      apiVersion: 'serving.knative.dev/v1', kind: 'Service',
      metadata: { annotations: { 'run.googleapis.com/ingress': s.ingress, 'serving.knative.dev/creator': s.revs[0].by, 'serving.knative.dev/lastModifier': s.revs[s.revs.length - 1].by }, creationTimestamp: G.iso(s.created, 6), generation: s.revs.length, labels: { 'cloud.googleapis.com/location': s.region }, name: s.name, namespace: p.projectNumber, resourceVersion: G.alnum('rv' + s.revs.length, 12), selfLink: `/apis/serving.knative.dev/v1/namespaces/${p.projectNumber}/services/${s.name}`, uid: G.uuid('uid' + s.name) },
      spec: { template: { metadata: { annotations: Object.assign({ 'autoscaling.knative.dev/maxScale': String(ok.max) }, ok.min ? { 'autoscaling.knative.dev/minScale': String(ok.min) } : {}, (ok.cloudsql || []).length ? { 'run.googleapis.com/cloudsql-instances': ok.cloudsql.join(',') } : {}), name: ok.name }, spec: { containerConcurrency: ok.concurrency, containers: [{ env: Object.keys(ok.env || {}).length ? Object.keys(ok.env).sort().map((k) => ({ name: k, value: ok.env[k] })) : undefined, image: ok.image, ports: [{ containerPort: ok.port, name: 'http1' }], resources: { limits: { cpu: ok.cpu, memory: ok.mem } } }], serviceAccountName: ok.sa, timeoutSeconds: ok.timeout } },
        traffic: s.traffic.map((t) => (t.latest ? { latestRevision: true, percent: t.percent } : { percent: t.percent, revisionName: t.rev })).concat(Object.entries(s.tags).map(([tag, rv]) => ({ revisionName: rv, tag }))) },
      status: { address: { url: G.runUrl(c.w, s) }, conditions: [{ lastTransitionTime: G.iso(ok.created, 6), status: 'True', type: 'Ready' }], latestCreatedRevisionName: s.revs[s.revs.length - 1].name, latestReadyRevisionName: ok.name, observedGeneration: s.revs.length, traffic: trafficOf(s).map((t) => Object.assign({ percent: t.percent, revisionName: t.rev }, t.latest ? { latestRevision: true } : {})), url: G.runUrl(c.w, s) },
    };
  };
  G.gc('run services describe', { pos: ['SERVICE'], flags: { region: 'v' }, run: async (c) => {
    const s = getSvc(c, c.p[0], 'run.services.get');
    if (c.a.format) return knative(c, s);
    c.out(describeText(c, s));
  } });
  G.gc('run services update', { pos: ['SERVICE'], flags: DEPLOY_FLAGS, run: async (c) => {
    getSvc(c, c.p[0], 'run.services.update');
    await deploy(c);
  } });
  G.gc('run services update-traffic', { pos: ['SERVICE'], flags: { region: 'v', 'to-revisions': 'v', 'to-latest': 'b', 'to-tags': 'v', 'set-tags': 'v', 'update-tags': 'v', 'remove-tags': 'v' }, run: async (c) => {
    const s = getSvc(c, c.p[0], 'run.services.update');
    const okNames = s.revs.filter((r) => !r.failed).map((r) => r.name);
    const latest = okNames[okNames.length - 1];
    if (c.a['to-latest']) s.traffic = [{ latest: true, percent: 100 }];
    else if (c.a['to-revisions'] || c.a['to-tags']) {
      const parts = (c.a['to-revisions'] || c.a['to-tags']).split(',').map((x) => { const [r, p] = x.split('='); return { rev: c.a['to-tags'] ? s.tags[r] : r === 'LATEST' ? latest : r, percent: Number(p) }; });
      for (const p of parts) if (!okNames.includes(p.rev)) throw E.plain(`The following revisions were not found: ${p.rev}`);
      const sum = parts.reduce((n, p) => n + p.percent, 0);
      if (sum > 100) throw E.plain(`The sum of the traffic percentages ([${sum}]) must not exceed 100.`);
      // 指定しなかった分は、今の割り当てから比例して残す（ここでは、最初の割り当てに足す）
      const rest = 100 - sum;
      const now = trafficOf(s).filter((t) => !parts.some((p) => p.rev === t.rev));
      const out = parts.map((p) => ({ rev: p.rev, percent: p.percent }));
      if (rest > 0) { if (now.length) out.push({ rev: now[0].rev, percent: rest }); else out[0].percent += rest; }
      s.traffic = out.filter((t) => t.percent > 0);
    }
    if (c.a['update-tags'] || c.a['set-tags']) { if (c.a['set-tags']) s.tags = {}; for (const x of (c.a['update-tags'] || c.a['set-tags']).split(',')) { const [tg, r] = x.split('='); s.tags[tg] = r === 'LATEST' ? latest : r; } }
    if (c.a['remove-tags']) for (const tg of c.a['remove-tags'].split(',')) delete s.tags[tg];
    G.tick(c.w, 8000);
    c.err(`✓ Updating traffic... Done.\n  ✓ Routing traffic...\nDone.\nURL: ${G.runUrl(c.w, s)}\nTraffic:\n`);
    let t = '';
    for (const x of trafficOf(s)) t += `  ${String(x.percent).padStart(3)}% ${x.latest ? `LATEST (currently ${x.rev})` : x.rev}\n`;
    for (const [tg, rv] of Object.entries(s.tags)) t += `        ${rv}\n          ${tg}: https://${tg}---${s.name}-${c.w.projects[s.project].projectNumber}.${s.region}.run.app\n`;
    c.err(t);
  } });
  G.gc('run services delete', { pos: ['SERVICE'], flags: { region: 'v', async: 'b' }, run: async (c) => {
    const s = getSvc(c, c.p[0], 'run.services.delete');
    c.confirm(`Service [${s.name}] will be deleted.`);
    delete R(c.w).services[svcKey(s.project, s.region, s.name)];
    delete c.w.policies[svcRes(s)];
    G.dropInstances(c.w, s);
    G.tick(c.w, 6000);
    c.err(`Deleting [${s.name}]...done.\nDeleted service [${s.name}].\n`);
  } });
  G.iamCmds('run services', { pos: 'SERVICE', flags: { region: 'v' }, res: (c) => {
    const pid = c.need();
    const region = regionArg(c);
    const s = R(c.w).services[svcKey(pid, region, c.p[0])];
    if (!s) throw new G.Err(404, '', '', { gcloud: `Cannot find service [${c.p[0]}]` });
    return { name: svcRes(s), project: pid, svc: 'run.googleapis.com', getPerm: 'run.services.getIamPolicy', setPerm: 'run.services.setIamPolicy', kind: 'service', label: s.name, resType: 'cloud_run_revision' };
  } });
  G.gc('run revisions list', { flags: { region: 'v', service: 'v' }, fmt: 'table(ok:label="", metadata.name:label=REVISION, active:label=ACTIVE, service:label=SERVICE, deployed:label=DEPLOYED, by:label="DEPLOYED BY")', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.cloud.run.v1.Revisions.ListRevisions', perm: 'run.revisions.list', res: 'projects/' + pid, svc: 'run.googleapis.com', project: pid, read: true });
    const out = [];
    for (const s of Object.values(R(c.w).services)) {
      if (s.project !== pid || (c.a.service && s.name !== c.a.service) || (c.a.region && s.region !== c.a.region)) continue;
      const tr = trafficOf(s);
      for (const r of s.revs.slice().reverse()) out.push({ ok: r.failed ? '✖' : '✔', metadata: { name: r.name }, active: tr.some((t) => t.rev === r.name && t.percent > 0) ? 'yes' : '', service: s.name, deployed: G.iso(r.created, 0).replace('T', ' ').replace('Z', ' UTC'), by: r.by });
    }
    return out;
  } });
  G.gc('run services logs read', { pos: ['SERVICE'], flags: { region: 'v', limit: 'v', 'log-filter': 'v' }, run: async (c) => {
    const s = getSvc(c, c.p[0], 'run.services.get');
    const lim = Number(c.a.limit || 20);
    const entries = c.w.logs.filter((e) => e.resource.type === 'cloud_run_revision' && e.resource.labels.service_name === s.name && e.resource.labels.location === s.region && !e.protoPayload).slice(-lim);
    for (const e of entries) c.out(`${e.timestamp.slice(0, 19).replace('T', ' ')} ${e.httpRequest ? `${e.httpRequest.requestMethod} ${e.httpRequest.status} ${e.httpRequest.requestUrl}` : (e.textPayload !== undefined ? e.textPayload : JSON.stringify(e.jsonPayload))}\n`);
  } });

  // ---------------------------------------------------------------- インスタンス（ページの中に持つ）
  const INST = new WeakMap();
  const instMap = (w) => { let m = INST.get(w); if (!m) { m = new Map(); INST.set(w, m); } return m; };
  G.dropInstances = (w, s) => { const m = instMap(w); for (const k of [...m.keys()]) if (k.startsWith(svcKey(s.project, s.region, s.name) + '#')) m.delete(k); };
  const runLog = (w, s, rev, sev, text, extra) => {
    const resource = { type: 'cloud_run_revision', labels: { configuration_name: s.name, location: s.region, project_id: s.project, revision_name: rev.name, service_name: s.name } };
    let payload = { textPayload: text };
    // どの出力に書いたか（console.error / warn は stderr）。ログ名はこれで決まる
    const stream = sev === 'ERROR' || sev === 'WARNING' ? 'stderr' : 'stdout';
    // 書いたままの文字列は、stdout なら DEFAULT、stderr なら ERROR
    let level = stream === 'stderr' ? 'ERROR' : sev === 'INFO' ? 'DEFAULT' : sev;
    // 1 行の JSON は構造化ログ（severity は取り出して、エントリの severity にする）
    if (/^\s*\{/.test(text)) { try { const j = JSON.parse(text); if (j.severity) { level = String(j.severity).toUpperCase(); delete j.severity; } payload = { jsonPayload: j }; } catch (e) {} }
    return G.log(w, Object.assign({ logName: `projects/${s.project}/logs/run.googleapis.com%2F${extra && extra.req ? 'requests' : stream}`, resource, severity: extra && extra.req ? sev : level, labels: { instanceId: '00' + G.hex('inst' + rev.name, 60) } }, payload, extra && extra.req ? { httpRequest: extra.req } : {}));
  };
  G.runLog = runLog;
  // インスタンスを起動する。probe：デプロイのときの確認（失敗の理由を返す）
  async function startInstance(sys, s, rev, probe) {
    const w = sys.w;
    const app = rev.app;
    const port = rev.port || 8080;
    const environ = Object.assign({ PORT: String(port), K_SERVICE: s.name, K_REVISION: rev.name, K_CONFIGURATION: s.name }, app.env || {}, rev.env || {});
    const failed = (why) => ({ ok: false, reason: why || `The user-provided container failed to start and listen on the port defined provided by the PORT=${port} environment variable within the allocated timeout. This can happen when the container port is misconfigured or if the timeout is too short. The health check timeout can be extended.` });
    if (app.kind === 'builtin') {
      if (app.port !== port) { runLog(w, s, rev, 'DEFAULT', `${app.name === 'nginx' ? '/docker-entrypoint.sh: Configuration complete; ready for start up' : 'Listening on port ' + app.port}`); runLog(w, s, rev, 'ERROR', `Default STARTUP TCP probe failed 1 time consecutively for container "${app.name}-1" on port ${port}. The instance was not started.`); return failed(); }
      if (!probe) runLog(w, s, rev, 'INFO', `Default STARTUP TCP probe succeeded after 1 attempt for container "${app.name}-1" on port ${port}.`);
      return { ok: true, inst: { app, environ, builtin: true } };
    }
    await G.preloadEngines(Object.values(app.files || {}).join('\n'));
    const env = {
      sys, w, filename: app.main, files: Object.assign({}, app.files), environ, timers: [], server: { list: [] }, cwd: '/workspace',
      who: rev.sa, project: s.project, inRun: { s, rev },
      log: (sev, text) => { for (const l of String(text).split('\n')) if (l || sev !== 'RAW') runLog(w, s, rev, sev === 'RAWERR' ? 'ERROR' : sev === 'RAW' ? 'DEFAULT' : sev, l); },
    };
    let handler = null;
    if (app.kind === 'function') {
      const r = G.jsRun(app.files[app.main] || '', env);
      if (r.error) { runLog(w, s, rev, 'ERROR', G.nodeErrText(r.error, '/workspace/' + app.main).trim()); return failed(); }
      const fns = env.fns || {};
      let f = fns[app.entry];
      if (!f && typeof r.exports[app.entry] === 'function') f = { kind: app.signature === 'event' ? 'event' : 'http', fn: r.exports[app.entry] };
      if (!f) { runLog(w, s, rev, 'ERROR', `Provided module can't be loaded.\nIs there a syntax error in your code?\nDetailed stack trace: Error: Function '${app.entry}' is not defined in the provided module.\nDid you specify the correct target function to execute?`); return failed(`Function '${app.entry}' is not defined in the provided module.`); }
      if (!probe) runLog(w, s, rev, 'INFO', `Default STARTUP TCP probe succeeded after 1 attempt for container "worker" on port ${port}.`);
      return { ok: true, inst: { fn: f, env } };
    }
    const r = G.jsRun(app.files[app.main] || '', env);
    await G.settle(4);
    if (r.error) { runLog(w, s, rev, 'ERROR', G.nodeErrText(r.error, '/workspace/' + app.main).trim()); return failed(); }
    const srv = env.server.list.find((x) => x.listening === port);
    if (!srv) { if (env.server.list.length) runLog(w, s, rev, 'DEFAULT', `（コンテナは ${env.server.list.map((x) => x.listening).join(', ')} 番で待ち受けています）`); runLog(w, s, rev, 'ERROR', `Default STARTUP TCP probe failed 1 time consecutively for container "${s.name}-1" on port ${port}. The instance was not started.`); return failed(); }
    if (!probe) runLog(w, s, rev, 'INFO', `Default STARTUP TCP probe succeeded after 1 attempt for container "${s.name}-1" on port ${port}.`);
    return { ok: true, inst: { handler: srv.handler, env } };
  }
  async function instanceFor(sys, s, rev) {
    const m = instMap(sys.w);
    const key = svcKey(s.project, s.region, s.name) + '#' + rev.name;
    let it = m.get(key);
    if (it && sys.w.t - it.last > 15 * 60000 && !(rev.min > 0)) { m.delete(key); it = null; }
    if (!it) {
      const st = await startInstance(sys, s, rev, false);
      if (!st.ok) return null;
      it = { inst: st.inst, last: sys.w.t, cold: true, n: 0 };
      m.set(key, it);
    } else it.cold = false;
    it.last = sys.w.t;
    it.n++;
    return it;
  }
  // 1 つの HTTP 要求を、リビジョンのインスタンスで処理する
  async function serve(sys, s, rev, req, u) {
    const w = sys.w;
    const it = await instanceFor(sys, s, rev);
    if (!it) return { status: 503, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: 'Service Unavailable' };
    const inst = it.inst;
    const query = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    let res;
    if (inst.builtin) res = builtinServe(inst.app, s, rev, req, u, inst.environ);
    else {
      res = G.makeRes();
      const rq = { method: req.method, url: u.pathname + u.search, path: u.pathname, originalUrl: u.pathname + u.search, query, headers: Object.assign({ host: u.host, 'user-agent': 'curl/8.5.0' }, req.headers), body: req.body === undefined ? (inst.fn ? {} : undefined) : req.body, get: (h) => rq.headers[String(h).toLowerCase()], header: (h) => rq.headers[String(h).toLowerCase()], ip: G.CLOUD_SHELL_IP, protocol: 'https', hostname: u.hostname };
      if (inst.fn && typeof rq.body === 'string' && !rq.body.trim()) rq.body = {};
      else if (inst.fn && typeof rq.body === 'string' && /json/.test(rq.headers['content-type'] || '')) { try { rq.body = JSON.parse(rq.body); } catch (e) { return { status: 400, headers: {}, body: 'Bad Request' }; } }
      rq.rawBody = req.body;
      const untrap = G.trapRejections((e) => { rq._err = rq._err || e; });
      try {
        const h = inst.fn ? inst.fn.fn : inst.handler;
        const p = h(rq, res);
        if (p && p.then) await p;
      } catch (e) { rq._err = e; }
      await G.settle(8);
      untrap();
      if (rq._err) {
        G.runLog(w, s, rev, 'ERROR', G.nodeErrText(rq._err, '/workspace/' + (inst.env.filename || 'index.js')).trim());
        if (!res.ended) { res.statusCode = 500; res.body = inst.fn ? 'Internal Server Error' : `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Internal Server Error</pre>\n</body>\n</html>\n`; res.ended = true; }
      }
      if (!res.ended) { G.advance(w, rev.timeout * 1000); res = { statusCode: 504, headers: { 'content-type': 'text/plain' }, body: 'upstream request timeout', ended: true }; }
    }
    const status = res.statusCode || res.status;
    const latency = (it.cold ? 1.2 + (G.hash(rev.name) % 900) / 1000 : 0.004 + (G.hash(rev.name + it.n) % 30) / 1000).toFixed(6);
    runLog(w, s, rev, status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'INFO', undefined, { req: { latency: latency + 's', protocol: 'HTTP/1.1', remoteIp: G.CLOUD_SHELL_IP, requestMethod: req.method, requestSize: String(220 + (req.body || '').length), requestUrl: u.href, responseSize: String(new TextEncoder().encode(res.body || '').length + 180), serverIp: '216.239.32.53', status, userAgent: 'curl/8.5.0' } });
    const last = w.logs[w.logs.length - 1]; delete last.textPayload;
    return { status, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, res.headers, { 'x-cloud-trace-context': G.hex('tr' + w.t, 32) + ';o=1', date: new Date(G.T0 + w.t).toUTCString(), server: 'Google Frontend' }), body: res.body };
  }
  function builtinServe(app, s, rev, req, u, env) {
    if (app.name === 'hello-app') return { statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `Hello, world!\nVersion: ${app.ver}\nHostname: localhost\n` };
    if (app.name === 'nginx') return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n</body>\n</html>\n' };
    // us-docker.pkg.dev/cloudrun/container/hello
    return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html>\n<html lang=en>\n<head><title>Congratulations | Cloud Run</title></head>\n<body>\n<h1>It's running!</h1>\n<p>Congratulations, you successfully deployed a container image to Cloud Run</p>\n<p>Service: ${env.K_SERVICE}<br>Revision: ${env.K_REVISION}${env.NAME ? `<br>NAME: ${env.NAME}` : ''}</p>\n</body>\n</html>\n` };
  }
  // 要求を受けるリビジョンを、トラフィックの割合で選ぶ（決まった順番で、割合どおりに回す）
  function pickRev(w, s, tag) {
    if (tag) { const n = s.tags[tag]; return s.revs.find((r) => r.name === n); }
    const tr = trafficOf(s).filter((t) => t.percent > 0);
    if (!tr.length) return null;
    // なめらかな重み付きラウンドロビン（50% と 50% なら交互に、90% と 10% なら 10 回に 1 回）
    s.wrr = s.wrr || {};
    for (const k of Object.keys(s.wrr)) if (!tr.some((t) => t.rev === k)) delete s.wrr[k];
    let best = null;
    for (const t of tr) { s.wrr[t.rev] = (s.wrr[t.rev] || 0) + t.percent; if (!best || s.wrr[t.rev] > s.wrr[best]) best = t.rev; }
    s.wrr[best] -= 100;
    return s.revs.find((r) => r.name === best);
  }
  const FORBIDDEN = (path) => `\n<html><head>\n<meta http-equiv="content-type" content="text/html;charset=utf-8">\n<title>403 Forbidden</title>\n</head>\n<body text=#000000 bgcolor=#ffffff>\n<h1>Error: Forbidden</h1>\n<h2>Your client does not have permission to get URL <code>${path}</code> from this server.</h2>\n<h2></h2>\n</body></html>\n`;
  const UNAUTH = (path) => `\n<html><head>\n<meta http-equiv="content-type" content="text/html;charset=utf-8">\n<title>401 Unauthorized</title>\n</head>\n<body text=#000000 bgcolor=#ffffff>\n<h1>Error: Unauthorized</h1>\n<h2>Your client does not have permission to the requested URL <code>${path}</code>.</h2>\n<h2></h2>\n</body></html>\n`;
  G.invokeService = async (sys, s, req, u, tag, opts = {}) => {
    const w = sys.w;
    if (s.ingress === 'internal' && !opts.internal && !(sys.vm && sys.vm.project === s.project)) return { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 404 (Not Found)!!1</title>\n  <p><b>404.</b> <ins>That’s an error.</ins>\n  <p>The requested URL <code>${u.pathname}</code> was not found on this server.  <ins>That’s all we know.</ins>\n` };
    const res = svcRes(s);
    const pub = G.check(w, null, 'run.routes.invoke', res).ok;
    if (!pub) {
      const b = opts.who ? { who: opts.who, kind: 'id' } : G.bearer(w, req);
      if (!b.who) return { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: FORBIDDEN(u.pathname) };
      if (b.kind !== 'id') return { status: 401, headers: { 'content-type': 'text/html; charset=UTF-8', 'www-authenticate': 'Bearer error="invalid_token" error_description="The access token could not be verified"' }, body: UNAUTH(u.pathname) };
      G.KNOWN.add('run.routes.invoke');
      if (!G.check(w, b.who, 'run.routes.invoke', res).ok) return { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: FORBIDDEN(u.pathname) };
    }
    const rev = pickRev(w, s, tag);
    if (!rev) return { status: 503, headers: {}, body: 'Service Unavailable' };
    return serve(sys, s, rev, req, u);
  };
  G.ROUTES.push({
    name: 'run',
    match: (w, u) => /\.run\.app$/.test(u.hostname) || /\.cloudfunctions\.net$/.test(u.hostname),
    handle: async (sys, req, u) => {
      const w = sys.w;
      let m = u.hostname.match(/^(?:([a-z0-9-]+)---)?([a-z0-9-]+)-(\d{12})\.([a-z0-9-]+)\.run\.app$/);
      let s = null, tag = null;
      if (m) {
        tag = m[1] || null;
        const p = Object.values(w.projects).find((x) => x.projectNumber === m[3]);
        s = p && p.lifecycleState === 'ACTIVE' && R(w).services[svcKey(p.projectId, m[4], m[2])];
      }
      const fr = RUN_REGIONS.find((r) => u.hostname.startsWith(r + '-'));
      const fm = fr && u.hostname.endsWith('.cloudfunctions.net') ? [null, fr, u.hostname.slice(fr.length + 1, -'.cloudfunctions.net'.length)] : null;
      if (fm) {
        const fname = u.pathname.split('/')[1];
        const f = F(w).functions[`${fm[2]}/${fm[1]}/${fname}`];
        if (f) { s = R(w).services[svcKey(fm[2], fm[1], f.service)]; u = new URL(u.href.replace(`/${fname}`, '') || '/'); }
        if (!f) return { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: `\n<html><head>\n<meta http-equiv="content-type" content="text/html;charset=utf-8">\n<title>404 Page not found</title>\n</head>\n<body text=#000000 bgcolor=#ffffff>\n<h1>Error: Page not found</h1>\n<h2>The requested URL was not found on this server.</h2>\n<h2></h2>\n</body></html>\n` };
      }
      if (!s) return { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 404 (Page not found)!!1</title>\n  <p><b>404.</b> <ins>That’s an error.</ins>\n  <p>The requested URL was not found on this server.  <ins>That’s all we know.</ins>\n` };
      return G.invokeService(sys, s, req, u, tag);
    },
  });

  // ---------------------------------------------------------------- Cloud Run functions（gcloud functions …）
  const fnKey = (pid, region, name) => `${pid}/${region}/${name}`;
  const fnView = (w, f) => {
    const s = R(w).services[svcKey(f.project, f.region, f.service)];
    const rev = s && s.revs.filter((r) => !r.failed).pop();
    const p = w.projects[f.project];
    return {
      buildConfig: { automaticUpdatePolicy: {}, build: `projects/${p.projectNumber}/locations/${f.region}/builds/${G.uuid('fb' + f.name + f.updated)}`, dockerRepository: `projects/${f.project}/locations/${f.region}/repositories/gcf-artifacts`, entryPoint: f.entry, runtime: f.runtime, serviceAccount: `projects/${f.project}/serviceAccounts/${p.projectNumber}-compute@developer.gserviceaccount.com`, source: { storageSource: { bucket: `gcf-v2-sources-${p.projectNumber}-${f.region}`, generation: String(G.T0 + f.updated) + '000', object: `${f.name}/function-source.zip` } } },
      createTime: G.iso(f.created, 9), environment: 'GEN_2', eventTrigger: f.trigger ? { eventType: f.trigger.type, pubsubTopic: f.trigger.topic ? `projects/${f.project}/topics/${f.trigger.topic}` : undefined, eventFilters: f.trigger.bucket ? [{ attribute: 'bucket', value: f.trigger.bucket }] : undefined, retryPolicy: 'RETRY_POLICY_DO_NOT_RETRY', serviceAccountEmail: `${p.projectNumber}-compute@developer.gserviceaccount.com`, trigger: `projects/${f.project}/locations/${f.region}/triggers/${f.name}-${G.alnum('trg' + f.name, 6)}`, triggerRegion: f.region } : undefined,
      labels: { 'deployment-tool': 'cli-gcloud' }, name: `projects/${f.project}/locations/${f.region}/functions/${f.name}`, satisfiesPzi: true,
      serviceConfig: s && rev ? { allTrafficOnLatestRevision: true, availableCpu: '0.1666', availableMemory: '256M', environmentVariables: Object.keys(rev.env || {}).length ? Object.assign({ LOG_EXECUTION_ID: 'true' }, rev.env) : { LOG_EXECUTION_ID: 'true' }, ingressSettings: 'ALLOW_ALL', maxInstanceCount: 100, maxInstanceRequestConcurrency: 1, revision: rev.name, service: `projects/${f.project}/locations/${f.region}/services/${f.service}`, serviceAccountEmail: rev.sa, timeoutSeconds: 60, uri: G.runUrl(w, s) } : undefined,
      state: f.state, updateTime: G.iso(f.updated, 9), url: `https://${f.region}-${f.project}.cloudfunctions.net/${f.name}`,
    };
  };
  G.gc('functions deploy', { pos: ['NAME'], flags: { gen2: 'b', 'no-gen2': 'b', runtime: 'v', region: 'v', source: 'v', 'entry-point': 'v', 'trigger-http': 'b', 'trigger-topic': 'v', 'trigger-bucket': 'v', 'trigger-event-filters': 'v*', 'allow-unauthenticated': 'b', 'set-env-vars': 'v', 'update-env-vars': 'v', memory: 'v', timeout: 'v', 'service-account': 'v', 'max-instances': 'v', 'min-instances': 'v', 'retry': 'b' }, run: async (c) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'functions/region');
    if (!region) throw E.plain(`Missing required argument [--region]: You must specify a region. Either use the \`--region\` flag or set the functions/region property.`);
    const name = c.p[0];
    const k = fnKey(pid, region, name);
    const old = F(c.w).functions[k];
    if (!c.a.runtime && !old) throw E.plain('Missing required argument [--runtime]: Flag `--runtime` is required for new functions.');
    const runtime = c.a.runtime || old.runtime;
    if (!/^nodejs(18|20|22|24)$/.test(runtime)) throw E.plain(/^(python|go|java|ruby|php|dotnet)/.test(runtime) ? `このサイトの関数は Node.js（--runtime=nodejs22 など）だけを動かせます。本物は ${runtime} も使えます。` : `Invalid value for [--runtime]: ${runtime} is not a supported runtime.`);
    if (!c.a['trigger-http'] && !c.a['trigger-topic'] && !c.a['trigger-bucket'] && !old) throw E.plain('You must specify a trigger when deploying a new function.');
    c.call({ method: 'google.cloud.functions.v2.FunctionService.CreateFunction', perm: old ? 'cloudfunctions.functions.update' : 'cloudfunctions.functions.create', res: 'projects/' + pid, svc: 'cloudfunctions.googleapis.com', project: pid, billable: true, resType: 'cloud_function', resLabels: { function_name: name, region } });
    for (const api of ['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com']) if (!c.w.projects[pid].services.includes(api)) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: ${G.APIS[api]} has not been used in project ${c.w.projects[pid].projectNumber} before or it is disabled.` });
    const dir = c.a.source || '.';
    if (!G.fs.isDir(c.sys, dir)) throw E.plain(`could not find source [${dir}]`);
    const files = G.fs.tree(c.sys, dir);
    if (files['package.json'] === undefined) throw new G.Err(0, 'PLAIN', 'OperationError: code=3, message=Build failed: Missing package.json file. package.json is required for Node.js functions.');
    let pkg; try { pkg = JSON.parse(files['package.json']); } catch (e) { throw new G.Err(0, 'PLAIN', `OperationError: code=3, message=Build failed: Unexpected token in package.json: ${e.message}`); }
    const main = pkg.main || 'index.js';
    if (files[main] === undefined) throw new G.Err(0, 'PLAIN', `OperationError: code=3, message=Build failed: function.js does not exist; Error ID: 7485c5b6`);
    const entry = c.a['entry-point'] || (old ? old.entry : name);
    let trigger = old ? old.trigger : null;
    if (c.a['trigger-http']) trigger = null;
    if (c.a['trigger-topic']) {
      trigger = { type: 'google.cloud.pubsub.topic.v1.messagePublished', topic: c.a['trigger-topic'] };
      if (G.ensureTopic) G.ensureTopic(c.w, pid, c.a['trigger-topic']);
    }
    if (c.a['trigger-bucket']) {
      if (!G.gcsBucket(c.w, c.a['trigger-bucket'])) throw new G.Err(0, 'PLAIN', `OperationError: code=3, message=Bucket ${c.a['trigger-bucket']} not found`);
      trigger = { type: 'google.cloud.storage.object.v1.finalized', bucket: c.a['trigger-bucket'] };
    }
    c.err('Preparing function...done.\n');
    const f = F(c.w).functions[k] = { project: pid, region, name, runtime, entry, trigger, service: name.toLowerCase(), created: old ? old.created : c.w.t, updated: c.w.t, state: 'DEPLOYING' };
    // 中身は Cloud Run のサービス
    const app = { kind: 'function', files: Object.assign({}, files), entry, main, signature: trigger ? 'event' : 'http' };
    const repoK = `${pid}/${region}/gcf-artifacts`;
    if (!A(c.w).repos[repoK]) A(c.w).repos[repoK] = { project: pid, loc: region, name: 'gcf-artifacts', format: 'DOCKER', desc: 'This repository is created and used by Cloud Functions for storing function docker images.', created: c.w.t, images: {} };
    const pr = pushImage(c, `${region}-docker.pkg.dev/${pid}/gcf-artifacts/${pid.replace(/-/g, '--')}__${region.replace(/-/g, '_')}__${name}:version_${(old ? old.v || 1 : 0) + 1}`, app);
    f.v = (old ? old.v || 1 : 0) + 1;
    const sk = svcKey(pid, region, f.service);
    let s = R(c.w).services[sk];
    if (!s) { s = R(c.w).services[sk] = { project: pid, region, name: f.service, revs: [], traffic: [{ latest: true, percent: 100 }], ingress: 'all', created: c.w.t, labels: { 'goog-managed-by': 'cloudfunctions' }, tags: {} }; c.w.policies[svcRes(s)] = { version: 1, etag: 'BwY' + G.alnum('svc' + sk, 9) + '=', bindings: [] }; }
    const prev = s.revs.filter((r) => !r.failed).pop();
    const o = applyFlags(c, { image: `${pr.ref}@${pr.digest}`, concurrency: 1, cpu: '166m', mem: c.a.memory || '256Mi', timeout: c.a.timeout ? parseInt(c.a.timeout, 10) : 60, max: 100 }, prev);
    G.tick(c.w, 90000);
    const buildUrl = `https://console.cloud.google.com/cloud-build/builds;region=${region}/${G.uuid('fb' + name + c.w.t)}?project=${c.w.projects[pid].projectNumber}`;
    const r = await newRevision(c, s, o);
    if (r.error) {
      f.state = 'FAILED';
      c.err(`X Deploying function...\n  ✓ [Build] Logs are available at [${buildUrl}]\n  X [Service] Container Healthcheck failed. ${r.error.split('\n')[0]}\n  . [ArtifactRegistry]\n  . [Healthcheck]\n${trigger ? '  . [Triggercheck]\n' : ''}Failed.\n`);
      throw new G.Err(0, 'PLAIN', `OperationError: code=3, message=Could not create or update Cloud Run service ${f.service}, Container Healthcheck failed. ${r.error}`);
    }
    if (c.a['allow-unauthenticated']) G.addBinding(c, svcRes(s), 'service', s.name, 'allUsers', 'roles/run.invoker', null);
    // トピックのトリガー：Eventarc が push のサブスクリプションを作る
    if (trigger && trigger.topic && G.makeTriggerSub) G.makeTriggerSub(c.w, f);
    f.state = 'ACTIVE';
    c.err(`✓ Deploying function...\n  ✓ [Build] Logs are available at [${buildUrl}]\n  ✓ [Service]\n  ✓ [ArtifactRegistry]\n  ✓ [Healthcheck]\n${trigger ? '  ✓ [Triggercheck]\n' : ''}Done.\nYou can view your function in the Cloud Console here: https://console.cloud.google.com/functions/details/${region}/${name}?project=${pid}\n\n`);
    if (!c.a.format) return fnView(c.w, f);
    return fnView(c.w, f);
  }, fmt: 'yaml' });
  const getFn = (c, name, perm) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'functions/region');
    if (!region) throw E.plain(`Missing required argument [--region]: You must specify a region. Either use the \`--region\` flag or set the functions/region property.`);
    c.call({ method: 'google.cloud.functions.v2.FunctionService.GetFunction', perm, res: 'projects/' + pid, svc: 'cloudfunctions.googleapis.com', project: pid, read: true });
    const f = F(c.w).functions[fnKey(pid, region, name)];
    if (!f) throw new G.Err(404, '', '', { gcloud: `ResponseError: status=[404], code=[Ok], message=[Resource 'projects/${pid}/locations/${region}/functions/${name}' was not found]` });
    return f;
  };
  G.gc('functions list', { flags: { regions: 'v', 'v2': 'b' }, fmt: 'table(name.basename(), state, trigger:label=TRIGGER, name.segment(3):label=REGION, environment)', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListFunctions', perm: 'cloudfunctions.functions.list', res: 'projects/' + pid, svc: 'cloudfunctions.googleapis.com', project: pid, read: true });
    return Object.values(F(c.w).functions).filter((f) => f.project === pid).map((f) => Object.assign(fnView(c.w, f), { trigger: f.trigger ? (f.trigger.topic ? 'topic: ' + f.trigger.topic : 'bucket: ' + f.trigger.bucket) : 'HTTP Trigger' }));
  } });
  G.gc('functions describe', { pos: ['NAME'], flags: { region: 'v', gen2: 'b' }, fmt: 'yaml', run: async (c) => fnView(c.w, getFn(c, c.p[0], 'cloudfunctions.functions.get')) });
  G.gc('functions delete', { pos: ['NAME'], flags: { region: 'v', gen2: 'b' }, run: async (c) => {
    const f = getFn(c, c.p[0], 'cloudfunctions.functions.delete');
    c.confirm(`2nd gen function [projects/${f.project}/locations/${f.region}/functions/${f.name}] will be deleted.`);
    delete F(c.w).functions[fnKey(f.project, f.region, f.name)];
    const s = R(c.w).services[svcKey(f.project, f.region, f.service)];
    if (s) { delete R(c.w).services[svcKey(f.project, f.region, f.service)]; G.dropInstances(c.w, s); }
    if (G.dropTriggerSub) G.dropTriggerSub(c.w, f);
    c.err('Preparing function...done.\nDeleting function...\n  ✓ [Service]\nDone.\n');
  } });
  G.gc('functions call', { pos: ['NAME'], flags: { region: 'v', data: 'v', gen2: 'b', 'cloud-event': 'v' }, run: async (c) => {
    const f = getFn(c, c.p[0], 'cloudfunctions.functions.call');
    const s = R(c.w).services[svcKey(f.project, f.region, f.service)];
    const u = new URL(G.runUrl(c.w, s) + '/');
    const req = { method: 'POST', url: u.href, headers: { 'content-type': 'application/json' }, body: c.a.data || '' };
    const r = await G.invokeService(c.sys, s, req, u, null, { who: c.as() });
    if (r.status >= 400) throw new G.Err(0, 'PLAIN', `ResponseError: status=[${r.status}], code=[${G.STATUS[r.status] || ''}], message=[${String(r.body).replace(/<[^>]+>/g, '').trim().split('\n').filter(Boolean).slice(-2).join(' ')}]`);
    c.out(r.body + (r.body.endsWith('\n') ? '' : '\n'));
  } });
  G.gc('functions logs read', { pos: ['[NAME]'], flags: { region: 'v', limit: 'v', gen2: 'b', 'execution-id': 'v' }, fmt: 'table(level, name, execution_id, time_utc, log)', run: async (c) => {
    const pid = c.need();
    const f = c.p[0] ? getFn(c, c.p[0], 'cloudfunctions.functions.get') : null;
    const lim = Number(c.a.limit || 20);
    const entries = c.w.logs.filter((e) => e.resource.type === 'cloud_run_revision' && e.resource.labels.project_id === pid && (!f || e.resource.labels.service_name === f.service) && !e.httpRequest && !e.protoPayload && (e.textPayload !== undefined || e.jsonPayload)).slice(-lim).reverse();
    return entries.map((e) => ({ level: e.severity === 'DEFAULT' ? '' : e.severity.slice(0, 1), name: f ? f.name : e.resource.labels.service_name, execution_id: e.labels && e.labels.execution_id || '', time_utc: e.timestamp.slice(0, 23).replace('T', ' '), log: e.textPayload !== undefined ? e.textPayload : (e.jsonPayload.message !== undefined ? e.jsonPayload.message : JSON.stringify(e.jsonPayload)) }));
  } });
  // CloudEvent を関数に渡す（Pub/Sub と Cloud Storage のトリガーから）
  G.deliverEvent = async (sys, f, ce) => {
    const w = sys.w;
    const s = R(w).services[svcKey(f.project, f.region, f.service)];
    if (!s) return false;
    const rev = s.revs.filter((r) => !r.failed).pop();
    const it = await instanceFor(sys, s, rev);
    if (!it || !it.inst.fn) return false;
    const exec = G.alnum('ex' + w.t + ce.id, 12);
    const env = it.inst.env;
    const saveLog = env.log;
    env.log = (sev, text) => { for (const l of String(text).split('\n')) { const e = runLog(w, s, rev, sev === 'RAWERR' ? 'ERROR' : sev === 'RAW' ? 'DEFAULT' : sev, l); e.labels.execution_id = exec; } };
    let err = null;
    const untrap = G.trapRejections((e) => { err = err || e; });
    try { const p = it.inst.fn.fn(ce); if (p && p.then) await p; } catch (e) { err = e; }
    await G.settle(8);
    untrap();
    env.log = saveLog;
    if (err) { const e = runLog(w, s, rev, 'ERROR', G.nodeErrText(err, '/workspace/index.js').trim()); e.labels.execution_id = exec; }
    runLog(w, s, rev, err ? 'ERROR' : 'INFO', undefined, { req: { latency: '0.0' + (G.hash(exec) % 90 + 10) + 's', protocol: 'HTTP/1.1', requestMethod: 'POST', requestUrl: G.runUrl(w, s) + '/', status: err ? 500 : 204, userAgent: 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)' } });
    const last = w.logs[w.logs.length - 1]; delete last.textPayload;
    return !err;
  };
  // Cloud Storage にオブジェクトができたとき
  G.EVENT_HANDLERS['gcs.finalize'] = async (sys, ev) => {
    for (const f of Object.values(F(sys.w).functions)) {
      if (!f.trigger || f.trigger.bucket !== ev.bucket || f.state !== 'ACTIVE') continue;
      const id = G.digits('ce' + ev.bucket + ev.name + ev.gen, 16);
      await G.deliverEvent(sys, f, { id, source: `//storage.googleapis.com/projects/_/buckets/${ev.bucket}`, specversion: '1.0', type: 'google.cloud.storage.object.v1.finalized', subject: `objects/${ev.name}`, time: G.iso(sys.w.t, 6), data: { bucket: ev.bucket, name: ev.name, contentType: ev.ctype, size: String(ev.size), generation: String(ev.gen), timeCreated: G.iso(sys.w.t), storageClass: ev.cls, kind: 'storage#object' } });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
