// gcloud コマンドの骨組み（引数の読み方、共通のフラグ、エラーの表示）と、入れ物の操作：
// config、auth、projects、organizations、resource-manager folders、services、billing、iam、org-policies。
// 各サービスは GCP.gc('storage buckets create', spec) でコマンドを足す。
//   spec = { pos: ['NAME', '[NAME …]'], flags: { 'display-name': 'v', quiet: 'b', 'member': 'v*'(何回でも) }, run: async (c) => { … }, fmt: '既定の書式' }
//   c = { sys, w, a(フラグ), p(位置引数), who, project, region, zone, out, err, stdin, path }
//   run が返した値は、--format（なければ spec.fmt）で表示する。undefined なら何も表示しない
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  const CMD = {};
  G.GC = CMD;
  G.gc = (path, spec) => { CMD[path] = spec; };
  G.GCLOUD_VERSION = '548.0.0';

  // ---------------------------------------------------------------- 設定（gcloud config）
  const PROPS = {
    core: ['account', 'project', 'disable_usage_reporting', 'verbosity', 'log_http', 'disable_prompts', 'user_output_enabled'],
    compute: ['region', 'zone'],
    run: ['region', 'platform'],
    functions: ['region'],
    auth: ['impersonate_service_account'],
    billing: ['quota_project'],
    artifacts: ['location', 'repository'],
  };
  const conf = (w) => w.cfg.configurations[G._cfgOverride || w.cfg.active];
  G.cfgGet = (w, name) => {
    const [s, k] = name.includes('/') ? name.split('/') : ['core', name];
    // 環境変数 CLOUDSDK_セクション_プロパティ は、構成の値より優先（gcloud を実行している間だけ見る）
    const env = G._env && G._env['CLOUDSDK_' + s.toUpperCase() + '_' + k.toUpperCase()];
    if (env != null && env !== '') return env;
    const c = G._cfgOverride ? w.cfg.configurations[G._cfgOverride] : conf(w);
    return c && c[s] ? c[s][k] : undefined;
  };
  function propName(name) {
    let [s, k] = name.includes('/') ? name.split('/') : ['core', name];
    if (!name.includes('/') && !PROPS.core.includes(k)) {
      const sec = Object.keys(PROPS).find((x) => PROPS[x].includes(k) && x !== 'core');
      if (sec && (k !== 'region' && k !== 'zone')) s = sec;
    }
    if (!PROPS[s]) throw E.plain(`Section [${s}] does not exist.`);
    if (!PROPS[s].includes(k)) throw E.plain(`Section [${s}] has no property [${k}].`);
    return [s, k];
  }
  G.prompt = (sys) => {
    if (sys.vm) return `${sys.root ? 'root' : 'you'}@${sys.vm.name}:${sys.sh.cwd === '/home/you' ? '~' : sys.sh.cwd}${sys.root ? '#' : '$'} `;
    const p = G.cfgGet(sys.w, 'core/project'); return `you@cloudshell:${sys.sh.cwd === '/home/you' ? '~' : sys.sh.cwd.replace(/^\/home\/you/, '~')}${p ? ` (${p})` : ''}$ `; };

  // ---------------------------------------------------------------- 引数を読む
  const GLOBAL = {
    project: 'v', account: 'v', format: 'v', filter: 'v', limit: 'v', 'sort-by': 'v', 'page-size': 'v', flatten: 'v*', quiet: 'b', q: 'b',
    'log-http': 'b', verbosity: 'v', 'impersonate-service-account': 'v', help: 'b', h: 'b', configuration: 'v', 'billing-project': 'v', uri: 'b', 'user-output-enabled': 'v',
  };
  function parseArgs(args, spec) {
    const flags = Object.assign({}, GLOBAL, spec.flags || {});
    const a = {}, p = [];
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === '--') { p.push(...args.slice(i + 1)); break; }
      if (/^--?[a-zA-Z]/.test(x) && !/^-\d/.test(x)) {
        let [k, v] = x.replace(/^--?/, '').split(/=(.*)/s);
        if (x.length === 2) k = x[1];
        let t = flags[k];
        let neg = false;
        if (!t && k.startsWith('no-') && flags[k.slice(3)] === 'b') { t = 'b'; neg = true; k = k.slice(3); }
        if (!t) throw E.usage(`unrecognized arguments: ${x}`);
        if (t === 'b') { a[k] = neg ? false : v === undefined ? true : !/^(false|0|no)$/i.test(v); continue; }
        if (v === undefined) {
          if (i + 1 >= args.length) throw E.usage(`argument --${k}: expected one argument`);
          v = args[++i];
        }
        if (t === 'v*') (a[k] = a[k] || []).push(v); else a[k] = v;
        continue;
      }
      p.push(x);
    }
    if (a.q) a.quiet = true;
    return { a, p };
  }
  // 位置引数の数を調べる
  function checkPos(spec, p) {
    const need = (spec.pos || []).filter((x) => !/^\[/.test(x));
    if (p.length < need.length) throw E.usage(`argument ${need.slice(p.length).join(' ')}: Must be specified.`);
    const many = (spec.pos || []).some((x) => /…|\.\.\./.test(x));
    if (!many && p.length > (spec.pos || []).length) throw E.usage(`unrecognized arguments: ${p.slice((spec.pos || []).length).join(' ')}`);
  }
  const usageLine = (path, spec) => `Usage: gcloud ${path} ${(spec.pos || []).join(' ')} ${Object.keys(spec.flags || {}).filter((k) => spec.req && spec.req.includes(k)).map((k) => `--${k}=${k.toUpperCase().replace(/-/g, '_')}`).join(' ')} [optional flags]`.replace(/ +/g, ' ');

  // ---------------------------------------------------------------- だれとして呼ぶか
  function identity(c) {
    const w = c.w;
    const acct = c.a.account || G.cfgGet(w, 'core/account');
    if (!acct) throw new G.Err(401, 'UNAUTH', '', { gcloud: 'You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.\n\nIf you have already logged in with a different account, run:\n\n  $ gcloud config set account ACCOUNT\n\nto select an already authenticated account to use.' });
    if (!(w.creds || []).includes(acct)) throw new G.Err(401, 'UNAUTH', '', { gcloud: `Your current active account [${acct}] does not have any valid credentials\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.\n\nFor service account, please activate it first:\n\n  $ gcloud auth activate-service-account ACCOUNT` });
    const imp = c.a['impersonate-service-account'] || G.cfgGet(w, 'auth/impersonate_service_account');
    if (!imp) return acct;
    c.err(`WARNING: This command is using service account impersonation. All API calls will be executed as [${imp}].\n`);
    const f = G.findSa(w, imp);
    const res = f ? `projects/${f.project}/serviceAccounts/${imp}` : null;
    if (!f || !G.check(w, acct, 'iam.serviceAccounts.getAccessToken', res).ok) {
      throw new G.Err(403, 'IMP', '', { gcloud: `Failed to impersonate [${imp}]. Make sure the account that's trying to impersonate it has access to the service account itself and the "roles/iam.serviceAccountTokenCreator" role.` });
    }
    return imp;
  }
  G.identity = identity;

  // ---------------------------------------------------------------- 実行（gcloud …）
  G.CMDS.gcloud = async (sys, args, io) => runGcloud(sys, args, io, 'gcloud');
  async function runGcloud(sys, args, io, top) {
    const w = sys.w;
    if (args[0] === '--version' || args[0] === '-v') args = ['version'];
    if (!args.length) { io.err(`ERROR: (gcloud) Command name argument expected.\n\nUsage: gcloud [optional flags] <group | command>\n  group may be           access-context-manager | ai | alpha | artifacts | auth | beta | billing | builds | compute | config | firestore | functions | iam | logging | monitoring | organizations | projects | pubsub | resource-manager | run | services | sql | storage | …\n  command may be         cheat-sheet | docker | feedback | help | info | init | survey | version\n\nFor detailed information on this command and its flags, run:\n  gcloud --help\n`); return 2; }
    // 先頭の beta / alpha は同じものとして扱う
    let rest = args.slice();
    const lead = [];
    while (rest[0] && /^--/.test(rest[0]) && GLOBAL[rest[0].replace(/^--/, '').split('=')[0]]) { lead.push(rest.shift()); if (!rest[-1] && GLOBAL[lead[lead.length - 1].slice(2)] === 'v' && !lead[lead.length - 1].includes('=')) lead.push(rest.shift()); }
    let track = '';
    if (rest[0] === 'beta' || rest[0] === 'alpha') track = rest.shift() + ' ';
    // いちばん長く当たるコマンドの名前
    let path = null, n = 0;
    for (let k = Math.min(rest.length, 5); k >= 1; k--) { const cand = rest.slice(0, k).join(' '); if (CMD[cand]) { path = cand; n = k; break; } }
    const dotted = (pth) => 'gcloud.' + (track ? track.trim() + '.' : '') + pth.replace(/ /g, '.');
    if (!path) {
      // グループまで合っているか
      let k = 0, group = '';
      for (let j = 1; j <= rest.length; j++) { const g = rest.slice(0, j).join(' '); if (Object.keys(CMD).some((x) => x.startsWith(g + ' '))) { k = j; group = g; } }
      const bad = rest[k];
      const choices = [...new Set(Object.keys(CMD).filter((x) => (group ? x.startsWith(group + ' ') : true)).map((x) => x.split(' ')[k]))].sort();
      const where = group ? `gcloud.${group.replace(/ /g, '.')}` : 'gcloud';
      if (bad === undefined || /^-/.test(bad)) io.err(`ERROR: (${where}) Command name argument expected.\n\nAvailable ${k ? 'commands' : 'groups'} for [gcloud${group ? ' ' + group : ''}]:\n\n${choices.map((x) => '      ' + x).join('\n')}\n\nFor detailed information on this command and its flags, run:\n  gcloud ${group ? group + ' ' : ''}--help\n`);
      else {
        const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
        const near = choices.filter((x) => lev(x, bad) <= 2 || x.startsWith(bad.slice(0, 3)));
        io.err(`ERROR: (${where}) Invalid choice: '${bad}'.\n${near.length ? `Maybe you meant:\n${near.slice(0, 4).map((x) => `  gcloud ${group ? group + ' ' : ''}${x}`).join('\n')}\n\n` : ''}To search the help text of gcloud commands, run:\n  gcloud help -- SEARCH_TERMS\n`);
      }
      return 2;
    }
    const spec = CMD[path];
    G._env = sys.sh.vars;
    try { return await runSpec(sys, args, io, path, spec, lead, rest, n, dotted); }
    finally { G._env = null; G._cfgOverride = null; }
  }
  async function runSpec(sys, args, io, path, spec, lead, rest, n, dotted) {
    const w = sys.w;
    let parsed;
    const cmdArgs = lead.concat(rest.slice(n));
    const c = { sys, w, path, out: io.out, err: io.err, stdin: io.stdin || '', dotted: dotted(path) };
    try {
      parsed = parseArgs(cmdArgs, spec);
      if (parsed.a.help || parsed.a.h) { io.out(helpText(path, spec)); return 0; }
      checkPos(spec, parsed.p);
      for (const r of spec.req || []) if (parsed.a[r] === undefined) throw E.usage(`argument --${r}: Must be specified.`);
    } catch (e) {
      if (e instanceof G.Err && e.status === 'USAGE') { io.err(`ERROR: (${c.dotted}) ${e.message}\n${usageLine(path, spec)}\n  optional flags may be  ${Object.keys(spec.flags || {}).concat(['help']).sort().map((k) => '--' + k).join(' | ')}\n\nFor detailed information on this command and its flags, run:\n  gcloud ${path} --help\n`); return 2; }
      throw e;
    }
    if (parsed.a.configuration) {
      if (!w.cfg.configurations[parsed.a.configuration]) { io.err(`ERROR: (${c.dotted}) The configuration [${parsed.a.configuration}] does not exist.\n`); return 1; }
      G._cfgOverride = parsed.a.configuration;
    }
    Object.assign(c, { a: parsed.a, p: parsed.p, logHttp: !!parsed.a['log-http'] || G.cfgGet(w, 'core/log_http') === 'true', quiet: !!parsed.a.quiet || G.cfgGet(w, 'core/disable_prompts') === 'true' });
    c.project = parsed.a.project || G.cfgGet(w, 'core/project');
    c.region = (k) => parsed.a.region || G.cfgGet(w, (k || 'compute') + '/region') || (k && k !== 'compute' ? undefined : undefined);
    c.zone = () => parsed.a.zone || G.cfgGet(w, 'compute/zone');
    c.cmd = path.replace(/ /g, '.');
    c.need = () => { if (!c.project) throw new G.Err(0, 'PLAIN', 'The required property [project] is not currently set.\nIt can be set on a per-command basis by re-running your command with the [--project] flag.\n\nYou may set it for your current workspace by running:\n\n  $ gcloud config set project VALUE\n\nor it can be set temporarily by the environment variable [CLOUDSDK_CORE_PROJECT]'); return c.project; };
    c.as = () => { if (c._who === undefined) c._who = spec.noAuth ? null : identity(c); return c._who; };
    c.call = (o) => G.api({ w, who: c.as(), project: c.project, logHttp: c.logHttp, err: c.err, cmd: c.cmd, scopes: sys.vm ? sys.vm.scopes : null }, o);
    c.confirm = (msg) => {
      if (c.quiet) return true;
      if (msg) c.err(msg + '\n\n');
      const ans = (c.stdin || '').split('\n')[0].trim().toLowerCase();
      c.err('Do you want to continue (Y/n)?  ');
      c.err('\n\n');
      if (ans === 'n' || ans === 'no') throw new G.Err(0, 'PLAIN', 'Aborted by user.');
      return true;
    };
    try {
      G.advance(w, 900);
      if (!spec.noAuth) c.as();
      // VM の中から：Google の API に届く道（外部 IP、Cloud NAT、限定公開の Google アクセス）がなければ、つながらない
      if (sys.vm && !spec.noAuth && !spec.local && G.googleReach && !G.googleReach(w, sys.vm)) {
        G.advance(w, 75000);
        const host = path.startsWith('storage') ? 'storage.googleapis.com' : path.startsWith('compute') ? 'compute.googleapis.com' : path.split(' ')[0] + '.googleapis.com';
        io.err(`ERROR: gcloud crashed (ConnectionError): HTTPSConnectionPool(host='${host}', port=443): Max retries exceeded with url: /${path.split(' ')[0]}/v1/… (Caused by NewConnectionError('<urllib3.connection.HTTPSConnection object at 0x7f3c1a2b4d90>: Failed to establish a new connection: [Errno 110] Connection timed out'))\n\nIf you would like to report this issue, please run the following command:\n  gcloud feedback\n\nTo check gcloud for common problems, please run the following command:\n  gcloud info --run-diagnostics\n`);
        return 1;
      }
      const r = await spec.run(c);
      if (r !== undefined && r !== null) {
        const text = G.fmt.print(r, parsed.a.uri && spec.uri ? 'value(uri)' : parsed.a.format, spec.fmt, {
          filter: parsed.a.filter, limit: parsed.a.limit !== undefined ? Number(parsed.a.limit) : undefined, sortBy: parsed.a['sort-by'], flatten: parsed.a.flatten,
        });
        if (Array.isArray(r) && !text && spec.empty !== false && !parsed.a.format) io.err(spec.emptyMsg || 'Listed 0 items.\n');
        io.out(text);
      }
      return c.exit || 0;
    } catch (e) {
      if (!(e instanceof G.Err)) throw e;
      if (e.gcloud) { io.err(`ERROR: (${c.dotted}) ${e.gcloud}\n`); return 1; }
      if (e.status === 'USAGE') { io.err(`ERROR: (${c.dotted}) ${e.message}\n`); return 2; }
      if (e.status === 'PLAIN' || e.status === 'UNAUTH' || e.status === 'IMP') { io.err(`ERROR: (${c.dotted}) ${e.message}\n`); return 1; }
      io.err(`ERROR: (${c.dotted}) ${e.raw ? e.message : `${e.status}: ${e.message}`}\n`);
      if (e.detail) io.err(e.detail + '\n');
      return 1;
    }
  }
  G.runGcloud = runGcloud;
  function helpText(path, spec) {
    const fl = Object.keys(spec.flags || {}).sort();
    return `NAME\n    gcloud ${path} - ${spec.help || ''}\n\nSYNOPSIS\n    gcloud ${path} ${(spec.pos || []).join(' ')}${fl.length ? '\n        ' + fl.map((k) => `[--${k}${spec.flags[k] === 'b' ? '' : '=' + k.toUpperCase().replace(/-/g, '_')}]`).join(' ') : ''}\n        [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n    ${spec.desc || spec.help || ''}\n`;
  }

  // ---------------------------------------------------------------- 小道具
  G.op = (w, kind) => `operations/${kind}.${G.digits('op' + G.seq(w, 'op'), 19)}`;
  const opName = G.op;
  G.uuid = (s) => { const h = G.hex(s, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const getProject = (c, id, perm = 'resourcemanager.projects.get') => {
    const p = c.w.projects[id];
    const res = 'projects/' + id;
    if (!p || (p.lifecycleState === 'DELETED')) {
      throw new G.Err(403, 'PERMISSION_DENIED', `The caller does not have permission`, { raw: false });
    }
    c.call({ perm, res, method: 'GetProject', read: true, svc: '', url: `https://cloudresourcemanager.googleapis.com/v1/projects/${id}?alt=json` });
    return p;
  };
  G.getProject = getProject;
  const projView = (p) => ({
    createTime: p.createTime, lifecycleState: p.lifecycleState, name: p.name, parent: p.parent ? { id: p.parent.id, type: p.parent.type } : undefined,
    projectId: p.projectId, projectNumber: p.projectNumber, labels: Object.keys(p.labels || {}).length ? p.labels : undefined,
  });

  // ---------------------------------------------------------------- gcloud version / info / help
  G.gc('version', { noAuth: true, run: async (c) => { c.out(`Google Cloud SDK ${G.GCLOUD_VERSION}\nalpha 2026.11.07\nbeta 2026.11.07\nbq 2.1.25\ncore 2026.11.07\ngcloud-crc32c 1.0.0\ngsutil 5.35\n`); } });
  G.gc('help', { noAuth: true, pos: ['[COMMAND …]'], run: async (c) => { c.out('gcloud のヘルプは、このサイトでは各コマンドの --help で短く表示します（本物の gcloud help は、マニュアルのページを開きます）。\n'); } });
  G.gc('info', { noAuth: true, run: async (c) => {
    const w = c.w;
    c.out(`Google Cloud SDK [${G.GCLOUD_VERSION}]\n\nPlatform: [Linux, x86_64] uname_result(system='Linux', node='cs-${G.digits('cs', 12)}-default', release='6.6.105+', version='#1 SMP PREEMPT_DYNAMIC', machine='x86_64')\nInstallation Root: [/usr/lib/google-cloud-sdk]\nInstalled Components:\n  core: [2026.11.07]\n  gcloud: [2026.11.07]\n  bq: [2.1.25]\nSystem PATH: [/usr/local/bin:/usr/bin:/bin:/usr/lib/google-cloud-sdk/bin]\n\nInstallation Properties: [/usr/lib/google-cloud-sdk/properties]\nUser Config Directory: [/home/you/.config/gcloud]\nActive Configuration Name: [${w.cfg.active}]\nActive Configuration Path: [/home/you/.config/gcloud/configurations/config_${w.cfg.active}]\n\nAccount: [${G.cfgGet(w, 'core/account') || ''}]\nProject: [${G.cfgGet(w, 'core/project') || ''}]\n`);
  } });

  // ---------------------------------------------------------------- config
  G.gc('config set', { noAuth: true, pos: ['SECTION/PROPERTY', 'VALUE'], flags: { installation: 'b' }, run: async (c) => {
    const [s, k] = propName(c.p[0]);
    const cf = conf(c.w);
    (cf[s] = cf[s] || {})[k] = c.p[1];
    if (s === 'compute' && k === 'zone' && !c.w.projects) {}
    c.err(`Updated property [${s}/${k}].\n`);
    if (s === 'core' && k === 'project' && G.cfgGet(c.w, 'core/account')) {
      const p = c.w.projects[c.p[1]];
      const who = G.cfgGet(c.w, 'core/account');
      const vis = p && p.lifecycleState === 'ACTIVE' && G.check(c.w, who, 'resourcemanager.projects.get', 'projects/' + c.p[1]).ok;
      if (!vis) c.err(`WARNING: [${who}] does not have permission to access projects instance [${c.p[1]}] (or it may not exist): The caller does not have permission. This command is authenticated as ${who} which is the active account specified by the [core/account] property\nAre you sure you wish to set property [core/project] to ${c.p[1]}?\n\nDo you want to continue (Y/n)?  \n\nUpdated property [core/project].\n`);
    }
    if (s === 'core' && k === 'account' && !(c.w.creds || []).includes(c.p[1])) {}
  } });
  G.gc('config unset', { noAuth: true, pos: ['SECTION/PROPERTY'], run: async (c) => {
    const [s, k] = propName(c.p[0]);
    const cf = conf(c.w);
    if (cf[s]) delete cf[s][k];
    c.err(`Unset property [${s}/${k}].\n`);
  } });
  G.gc('config get', { noAuth: true, pos: ['SECTION/PROPERTY'], run: async (c) => {
    const [s, k] = propName(c.p[0]);
    const v = G.cfgGet(c.w, s + '/' + k);
    if (v === undefined) { c.err('(unset)\n'); return; }
    c.out(v + '\n');
  } });
  G.gc('config get-value', { noAuth: true, pos: ['SECTION/PROPERTY'], run: async (c) => {
    const [s, k] = propName(c.p[0]);
    const v = G.cfgGet(c.w, s + '/' + k);
    if (v === undefined) { c.err('(unset)\n'); return; }
    c.out(v + '\n');
  } });
  G.gc('config list', { noAuth: true, flags: { all: 'b' }, run: async (c) => {
    const cf = conf(c.w);
    if (c.a.format) return Object.fromEntries(Object.entries(cf).filter(([, v]) => Object.keys(v).length));
    let s = '';
    for (const sec of Object.keys(cf).sort()) {
      const ks = Object.keys(cf[sec]).sort();
      if (!ks.length) continue;
      s += `[${sec}]\n` + ks.map((k) => `${k} = ${cf[sec][k]}`).join('\n') + '\n';
    }
    c.out(s);
    c.err(`\nYour active configuration is: [${c.w.cfg.active}]\n`);
  } });
  G.gc('config configurations list', { noAuth: true, fmt: 'table(name, is_active, properties.core.account, properties.core.project, properties.compute.zone:label=COMPUTE_DEFAULT_ZONE, properties.compute.region:label=COMPUTE_DEFAULT_REGION)', run: async (c) =>
    Object.keys(c.w.cfg.configurations).sort().map((n) => ({ name: n, is_active: n === c.w.cfg.active ? 'True' : 'False', properties: c.w.cfg.configurations[n] })) });
  G.gc('config configurations create', { noAuth: true, pos: ['NAME'], flags: { 'no-activate': 'b' }, run: async (c) => {
    if (c.w.cfg.configurations[c.p[0]]) throw E.plain(`Cannot create configuration [${c.p[0]}], it already exists.`);
    if (!/^[a-z][-a-z0-9]*$/.test(c.p[0])) throw E.plain(`Invalid name [${c.p[0]}] for a configuration.  Except for special cases (NONE), configuration names start with a lower case letter and contain only lower case letters a-z, digits 0-9, and hyphens '-'.`);
    c.w.cfg.configurations[c.p[0]] = { core: {} };
    c.err(`Created [${c.p[0]}].\n`);
    if (!c.a['no-activate']) { c.w.cfg.active = c.p[0]; c.err(`Activated [${c.p[0]}].\n`); }
  } });
  G.gc('config configurations activate', { noAuth: true, pos: ['NAME'], run: async (c) => {
    if (!c.w.cfg.configurations[c.p[0]]) throw E.plain(`Cannot activate configuration [${c.p[0]}], it does not exist.`);
    c.w.cfg.active = c.p[0];
    c.err(`Activated [${c.p[0]}].\n`);
  } });
  G.gc('config configurations describe', { noAuth: true, pos: ['NAME'], fmt: 'yaml', run: async (c) => {
    const cf = c.w.cfg.configurations[c.p[0]];
    if (!cf) throw E.plain(`The configuration [${c.p[0]}] does not exist.`);
    return { is_active: c.p[0] === c.w.cfg.active, name: c.p[0], properties: cf };
  } });
  G.gc('config configurations delete', { noAuth: true, pos: ['NAME …'], run: async (c) => {
    for (const n of c.p) {
      if (n === c.w.cfg.active) throw E.plain(`Deleting configuration [${n}], which is currently active, is not allowed.`);
      if (!c.w.cfg.configurations[n]) throw E.plain(`Unable to delete configuration [${n}], it does not exist.`);
      delete c.w.cfg.configurations[n];
      c.err(`Deleted [${n}].\n`);
    }
  } });

  // ---------------------------------------------------------------- auth
  G.token = (w, who, kind = 'access') => {
    const t = kind === 'id'
      ? 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjZh' + G.alnum(who + w.t, 40) + '.' + G.alnum('p' + who, 60) + '.' + G.alnum('s' + who + w.t, 43)
      : 'ya29.a0' + G.alnum(who + ':' + w.t + ':' + G.seq(w, 'tok'), 160);
    w.tokens[t] = { who, kind, exp: w.t + 3600 * 1000 };
    return t;
  };
  G.gc('auth list', { noAuth: true, flags: { 'filter-account': 'v' }, fmt: 'table(status.yesno("*", ""):label=ACTIVE, account)', run: async (c) => {
    const act = G.cfgGet(c.w, 'core/account');
    const rows = (c.w.creds || []).map((a) => ({ account: a, status: a === act ? 'ACTIVE' : '' }));
    if (c.a.format) return rows;
    if (!rows.length) { c.err('No credentialed accounts.\n\nTo login, run:\n  $ gcloud auth login `ACCOUNT`\n\n'); return; }
    c.err('Credentialed Accounts\n');
    c.out(G.fmt.print(rows, 'table(status.yesno("*", ""):label=ACTIVE, account)'));
    c.err('\nTo set the active account, run:\n    $ gcloud config set account `ACCOUNT`\n\n');
  } });
  G.gc('auth login', { noAuth: true, pos: ['[ACCOUNT]'], flags: { 'no-launch-browser': 'b', 'update-adc': 'b', brief: 'b' }, run: async (c) => {
    const acct = c.p[0];
    if (!acct) throw E.plain('このサイトの gcloud では、ログインするアカウントを引数で指定してください（例：gcloud auth login alice@tsubame.example）。本物では、ブラウザでアカウントを選びます。');
    const person = c.w.people[acct];
    if (!person) throw E.plain(`[${acct}] という Google アカウントは、このサイトの世界にはありません。いるのは ${Object.keys(c.w.people).join('、')} です。`);
    c.err('Go to the following link in your browser, and complete the sign-in prompts:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&…\n\nOnce finished, enter the verification code provided in your browser: \n');
    if (!(c.w.creds = c.w.creds || []).includes(acct)) c.w.creds.push(acct);
    conf(c.w).core.account = acct;
    c.err(`\nYou are now logged in as [${acct}].\nYour current project is [${G.cfgGet(c.w, 'core/project') || 'None'}].  You can change this setting by running:\n  $ gcloud config set project PROJECT_ID\n`);
  } });
  G.gc('auth revoke', { noAuth: true, pos: ['[ACCOUNTS …]'], flags: { all: 'b' }, run: async (c) => {
    const list = c.a.all ? (c.w.creds || []).slice() : c.p.length ? c.p : [G.cfgGet(c.w, 'core/account')];
    for (const a of list) {
      if (!(c.w.creds || []).includes(a)) throw E.plain(`Unknown account: ${a}`);
      c.w.creds = c.w.creds.filter((x) => x !== a);
      if (G.cfgGet(c.w, 'core/account') === a) delete conf(c.w).core.account;
    }
    c.err('Revoked credentials:\n' + list.map((a) => ' - ' + a).join('\n') + '\n');
  } });
  G.gc('auth activate-service-account', { noAuth: true, pos: ['[ACCOUNT]'], flags: { 'key-file': 'v' }, req: ['key-file'], run: async (c) => {
    const s = G.fs.read(c.sys, c.a['key-file']);
    if (s === null) throw E.plain(`Unable to read file [${c.a['key-file']}]: [Errno 2] No such file or directory: '${c.a['key-file']}'`);
    let k; try { k = JSON.parse(s); } catch (e) { throw E.plain('Could not read json file ' + c.a['key-file'] + ': Expecting value: line 1 column 1 (char 0)'); }
    const f = G.findSa(c.w, k.client_email);
    const key = f && (f.sa.keys || []).find((x) => x.id === k.private_key_id && !x.deleted);
    if (!key || f.sa.disabled) throw E.plain(`There was a problem refreshing your current auth tokens: ('invalid_grant: Invalid JWT Signature.', {'error': 'invalid_grant', 'error_description': 'Invalid JWT Signature.'})`);
    if (!(c.w.creds = c.w.creds || []).includes(k.client_email)) c.w.creds.push(k.client_email);
    conf(c.w).core.account = k.client_email;
    c.err(`Activated service account credentials for: [${k.client_email}]\n`);
  } });
  G.gc('auth print-access-token', { pos: ['[ACCOUNT]'], run: async (c) => { c.out(G.token(c.w, c.p[0] || c.as()) + '\n'); } });
  G.gc('auth print-identity-token', { pos: ['[ACCOUNT]'], flags: { audiences: 'v', 'include-email': 'b' }, run: async (c) => { c.out(G.token(c.w, c.p[0] || c.as(), 'id') + '\n'); } });
  G.gc('auth application-default login', { noAuth: true, flags: { 'no-launch-browser': 'b' }, run: async (c) => {
    const a = G.cfgGet(c.w, 'core/account');
    c.w.adc = a;
    G.fs.mkdir(c.sys, '/home/you/.config'); G.fs.mkdir(c.sys, '/home/you/.config/gcloud');
    G.fs.write(c.sys, '/home/you/.config/gcloud/application_default_credentials.json', JSON.stringify({ account: '', client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com', client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty', refresh_token: '1//0e' + G.alnum('adc' + a, 90), type: 'authorized_user', universe_domain: 'googleapis.com' }, null, 2) + '\n');
    c.err(`Go to the following link in your browser, and complete the sign-in prompts:\n\n    https://accounts.google.com/o/oauth2/auth?…\n\n\nCredentials saved to file: [/home/you/.config/gcloud/application_default_credentials.json]\n\nThese credentials will be used by any library that requests Application Default Credentials (ADC).\n`);
  } });

  // ---------------------------------------------------------------- projects
  const TAKEN = new Set(['my-project', 'my-first-project', 'test-project', 'hello-world', 'tsubame', 'demo-project', 'sample-project', 'project-1', 'gcp-test', 'my-app', 'shop', 'tsubame-bungu', 'tsubame-prod-old']);
  G.validProjectId = (id) => /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/.test(id);
  G.gc('projects list', { flags: { 'filter-id': 'v' }, fmt: 'table(projectId:sort=1, name, projectNumber)', uri: true, run: async (c) => {
    c.call({ method: 'ListProjects', read: true, svc: '', url: 'https://cloudresourcemanager.googleapis.com/v1/projects?alt=json&filter=lifecycleState%3AACTIVE&pageSize=500' });
    const who = c.as();
    return Object.values(c.w.projects).filter((p) => p.lifecycleState === 'ACTIVE' && G.check(c.w, who, 'resourcemanager.projects.get', 'projects/' + p.projectId).ok)
      .sort((a, b) => (a.projectId < b.projectId ? -1 : 1)).map((p) => Object.assign(projView(p), { uri: `https://cloudresourcemanager.googleapis.com/v1/projects/${p.projectId}` }));
  } });
  G.gc('projects describe', { pos: ['PROJECT_ID_OR_NUMBER'], fmt: 'yaml', run: async (c) => {
    const id = resolveProject(c.w, c.p[0]);
    const p = c.w.projects[id];
    if (!p || !G.check(c.w, c.as(), 'resourcemanager.projects.get', 'projects/' + id).ok) {
      throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access projects instance [${c.p[0]}] (or it may not exist): The caller does not have permission. This command is authenticated as ${c.as()} which is the active account specified by the [core/account] property` });
    }
    c.call({ method: 'GetProject', read: true, url: `https://cloudresourcemanager.googleapis.com/v1/projects/${id}?alt=json` });
    return projView(p);
  } });
  const resolveProject = (w, s) => (w.projects[s] ? s : (Object.values(w.projects).find((p) => p.projectNumber === s) || {}).projectId || s);
  G.resolveProject = resolveProject;
  G.gc('projects create', { pos: ['[PROJECT_ID]'], flags: { name: 'v', folder: 'v', organization: 'v', labels: 'v', 'set-as-default': 'b', 'enable-cloud-apis': 'b', tags: 'v' }, run: async (c) => {
    const id = c.p[0];
    if (!id) throw E.usage('argument PROJECT_ID: Must be specified.');
    if (!G.validProjectId(id)) throw E.usage(`argument PROJECT_ID: Bad value [${id}]: Project IDs must start with a lowercase letter and can have lowercase ASCII letters, digits or hyphens. Project IDs must be between 6 and 30 characters.`);
    if (c.a.folder && c.a.organization) throw E.usage('argument --folder: At most one of --folder | --organization can be specified.');
    // 組織のない個人の Google アカウントは、親のない（「組織なし」の）プロジェクトを作る
    const consumer = (c.w.people[c.as()] || {}).kind === 'consumer' && !c.a.folder && !c.a.organization;
    const parent = consumer ? null : c.a.folder ? { type: 'folder', id: c.a.folder } : { type: 'organization', id: c.a.organization || G.ORG_ID };
    const parentName = !parent ? null : parent.type === 'folder' ? 'folders/' + parent.id : 'organizations/' + parent.id;
    if (parent && parent.type === 'folder' && (!c.w.folders[parent.id] || c.w.folders[parent.id].lifecycleState !== 'ACTIVE')) throw new G.Err(403, 'PERMISSION_DENIED', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.projects.create' denied on resource '//cloudresourcemanager.googleapis.com/folders/${parent.id}' (or it may not exist).` });
    if (parent && parent.type === 'organization' && parent.id !== G.ORG_ID) throw new G.Err(403, 'PERMISSION_DENIED', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.projects.create' denied on resource '//cloudresourcemanager.googleapis.com/organizations/${parent.id}' (or it may not exist).` });
    const who = c.as();
    if (parent && !G.check(c.w, who, 'resourcemanager.projects.create', parentName).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.projects.create' denied on resource '//cloudresourcemanager.googleapis.com/${parentName}' (or it may not exist).` });
    if (c.w.projects[id] || TAKEN.has(id)) throw E.plain('Project creation failed. The project ID you specified is already in use by another project. Please try an alternative ID.');
    if (c.a.name !== undefined && (c.a.name.length < 4 || c.a.name.length > 30)) throw E.usage(`argument --name: Bad value [${c.a.name}]: Project name must be between 4 and 30 characters.`);
    c.call({ method: 'CreateProject', svc: 'cloudresourcemanager.googleapis.com', project: null, url: 'https://cloudresourcemanager.googleapis.com/v1/projects?alt=json', verb: 'POST', body: { projectId: id, name: c.a.name || id, parent } });
    const labels = {};
    if (c.a.labels) for (const kv of c.a.labels.split(',')) { const [k, v] = kv.split('='); labels[k] = v || ''; }
    G.makeProject(c.w, id, { name: c.a.name, parent, labels, creator: who });
    G.audit(c.w, { project: id, who, method: 'CreateProject', perm: 'resourcemanager.projects.create', res: 'projects/' + id, svc: 'cloudresourcemanager.googleapis.com', resType: 'project' });
    G.tick(c.w, 8000);
    c.err(`Create in progress for [https://cloudresourcemanager.googleapis.com/v1/projects/${id}].\nWaiting for [${opName(c.w, 'cp')}] to finish...done.\n`);
    if (c.a['enable-cloud-apis'] !== false) c.err(`Enabling service [cloudapis.googleapis.com] on project [${id}]...\nOperation "operations/acat.p2-${G.projectNumber(id)}-${G.uuid('acat' + id)}" finished successfully.\n`);
    if (c.a['set-as-default']) { conf(c.w).core.project = id; c.err('Updated property [core/project] to [' + id + '].\n'); }
  } });
  G.gc('projects update', { pos: ['PROJECT_ID'], flags: { name: 'v', 'update-labels': 'v', 'remove-labels': 'v' }, fmt: 'yaml', run: async (c) => {
    const p = getProject(c, c.p[0], 'resourcemanager.projects.update');
    c.call({ method: 'UpdateProject', perm: 'resourcemanager.projects.update', res: 'projects/' + p.projectId, svc: 'cloudresourcemanager.googleapis.com' });
    if (c.a.name) p.name = c.a.name;
    if (c.a['update-labels']) for (const kv of c.a['update-labels'].split(',')) { const [k, v] = kv.split('='); p.labels[k] = v || ''; }
    if (c.a['remove-labels']) for (const k of c.a['remove-labels'].split(',')) delete p.labels[k];
    c.err(`Updated [https://cloudresourcemanager.googleapis.com/v1/projects/${p.projectId}].\n`);
    return projView(p);
  } });
  G.gc('projects delete', { pos: ['PROJECT_ID_OR_NUMBER'], run: async (c) => {
    const id = resolveProject(c.w, c.p[0]);
    const p = c.w.projects[id];
    if (!p || p.lifecycleState !== 'ACTIVE' || !G.check(c.w, c.as(), 'resourcemanager.projects.get', 'projects/' + id).ok) throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access projects instance [${c.p[0]}] (or it may not exist): The caller does not have permission.` });
    c.confirm(`Your project will be deleted.`);
    c.call({ method: 'DeleteProject', perm: 'resourcemanager.projects.delete', res: 'projects/' + id, svc: 'cloudresourcemanager.googleapis.com', project: id, resType: 'project', url: `https://cloudresourcemanager.googleapis.com/v1/projects/${id}?alt=json`, verb: 'DELETE',
      deniedMsg: () => `The caller does not have permission` });
    p.lifecycleState = 'DELETE_REQUESTED';
    p.deleteTime = G.iso(c.w.t);
    G.later(c.w, 30 * 86400 * 1000, 'purgeProject', id);
    if (G.cfgGet(c.w, 'core/project') === id) {}
    c.err(`Deleted [https://cloudresourcemanager.googleapis.com/v1/projects/${id}].\n\nYou can undo this operation for a limited period by running the command below.\n    $ gcloud projects undelete ${id}\n\nSee https://cloud.google.com/resource-manager/docs/creating-managing-projects for information on shutting down projects.\n`);
  } });
  G.TIMER_FN = G.TIMER_FN || {};
  G.TIMER_FN.purgeProject = (w, id) => { const p = w.projects[id]; if (p && p.lifecycleState === 'DELETE_REQUESTED') p.lifecycleState = 'DELETED'; };
  G.gc('projects undelete', { pos: ['PROJECT_ID_OR_NUMBER'], run: async (c) => {
    const id = resolveProject(c.w, c.p[0]);
    const p = c.w.projects[id];
    if (!p || p.lifecycleState !== 'DELETE_REQUESTED') throw new G.Err(400, 'FAILED_PRECONDITION', '', { gcloud: `FAILED_PRECONDITION: Project is not in the DELETE_REQUESTED state.` });
    c.call({ method: 'UndeleteProject', perm: 'resourcemanager.projects.undelete', res: 'projects/' + id, svc: 'cloudresourcemanager.googleapis.com', project: id, allowDeleted: true });
    p.lifecycleState = 'ACTIVE'; p.deleteTime = '';
    c.err(`Restored project [https://cloudresourcemanager.googleapis.com/v1/projects/${id}].\n`);
  } });
  G.gc('projects move', { pos: ['PROJECT_ID'], flags: { folder: 'v', organization: 'v' }, run: async (c) => {
    const p = getProject(c, c.p[0]);
    const dest = c.a.folder ? { type: 'folder', id: c.a.folder } : c.a.organization ? { type: 'organization', id: c.a.organization } : null;
    if (!dest) throw E.usage('Exactly one of (--folder | --organization) must be specified.');
    const destName = dest.type === 'folder' ? 'folders/' + dest.id : 'organizations/' + dest.id;
    if (dest.type === 'folder' && !c.w.folders[dest.id]) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.projects.move' denied on resource '//cloudresourcemanager.googleapis.com/${destName}' (or it may not exist).` });
    c.call({ method: 'MoveProject', perm: 'resourcemanager.projects.update', res: 'projects/' + p.projectId, svc: 'cloudresourcemanager.googleapis.com', project: p.projectId });
    if (!G.check(c.w, c.as(), 'resourcemanager.projects.move', destName).ok && !G.check(c.w, c.as(), 'resourcemanager.projects.create', destName).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.projects.move' denied on resource '//cloudresourcemanager.googleapis.com/${destName}' (or it may not exist).` });
    p.parent = dest;
    c.err(`Moved [${p.projectId}] to [${destName}].\n`);
    c.out(G.toYAML(projView(p)) + '\n');
  } });
  G.gc('projects get-ancestors', { pos: ['PROJECT_ID'], fmt: 'table(id, type)', run: async (c) => {
    const p = getProject(c, c.p[0]);
    return G.ancestry(c.w, 'projects/' + p.projectId).map((n) => { const [t, id] = n.split('/'); return { id, type: t.replace(/s$/, '').replace('organization', 'organization') }; });
  } });

  // ---------------------------------------------------------------- IAM ポリシーの共通部品
  const orgPolicyOf = (w, resName, constraint) => {
    for (const n of G.ancestry(w, resName)) { const pol = (w.orgPolicies[n] || {})[constraint]; if (pol) { if (pol.reset) return null; return pol; } if ((w.orgPolicies[n] || {})['!' + constraint]) return null; }
    return null;
  };
  G.orgPolicyOf = orgPolicyOf;
  G.memberOk = (w, member) => {
    if (member === 'allUsers' || member === 'allAuthenticatedUsers') return true;
    const m = member.match(/^(user|group|serviceAccount|domain|projectOwner|projectEditor|projectViewer|principal|principalSet):(.+)$/);
    if (!m) return `Invalid member type for member [${member}]. Member type must be one of [user, group, domain, serviceAccount, projectOwner, projectEditor, projectViewer, allUsers, allAuthenticatedUsers, principal, principalSet].`;
    const [, k, v] = m;
    if (k === 'user' && !w.people[v]) return `User ${v} does not exist.`;
    if (k === 'group' && !w.groups[v]) return `Group ${v} does not exist.`;
    if (k === 'serviceAccount' && !G.findSa(w, v) && !/@(gcp-sa-[a-z-]+\.iam\.gserviceaccount\.com|cloudbuild\.gserviceaccount\.com|developer\.gserviceaccount\.com|cloudservices\.gserviceaccount\.com|serverless-robot-prod\.iam\.gserviceaccount\.com)$/.test(v)) return `Service account ${v} does not exist.`;
    if (k === 'user' && w.people[v] && w.people[v].kind === 'managed' && G.principalKind(w, v) === 'group') return `User ${v} does not exist.`;
    return true;
  };
  // 組織のポリシー iam.allowedPolicyMemberDomains：組織の外のアカウントを付けられない
  G.domainOk = (w, resName, member) => {
    const pol = orgPolicyOf(w, resName, 'iam.allowedPolicyMemberDomains');
    if (!pol) return true;
    const allowed = ((pol.spec.rules || [])[0] || {}).values ? pol.spec.rules[0].values.allowedValues || [] : [];
    if ((pol.spec.rules || []).some((r) => r.allowAll)) return true;
    const inCust = (email) => {
      if (/\.gserviceaccount\.com$/.test(email)) return true;
      const pp = w.people[email];
      if (pp) return pp.kind === 'managed' && allowed.includes(w.org.directoryCustomerId);
      if (w.groups[email]) return allowed.includes(w.org.directoryCustomerId);
      return false;
    };
    if (member === 'allUsers' || member === 'allAuthenticatedUsers') return false;
    const v = member.split(':')[1];
    if (member.startsWith('domain:')) return v === w.org.domain && allowed.includes(w.org.directoryCustomerId);
    return inCust(v);
  };
  G.policyView = (pol) => ({
    bindings: pol.bindings.filter((b) => b.members.length).map((b) => ({ condition: b.condition, members: b.members.slice().sort(), role: b.role })).sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
    etag: pol.etag, version: pol.version,
  });
  const bumpEtag = (w, pol) => { pol.etag = 'BwY' + G.alnum('etag' + G.seq(w, 'etag'), 9) + '='; };
  G.bumpEtag = bumpEtag;
  function parseCondition(s) {
    if (!s || s === 'None') return null;
    const out = {};
    for (const part of G.fmtSplit(s)) { const [k, v] = part.split(/=(.*)/s); out[k.trim()] = (v || '').trim(); }
    if (!out.expression || !out.title) throw E.usage('argument --condition: condition must have both expression and title');
    return { expression: out.expression, title: out.title, description: out.description };
  }
  G.fmtSplit = (s) => { const out = []; let cur = '', depth = 0, q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; continue; } cur += ch; } if (cur) out.push(cur); return out; };
  // ポリシーを書き換える（追加・削除）。kind は表示用（project / folder / organization / …）
  G.addBinding = (c, resName, kind, label, member, role, cond, opts = {}) => {
    const w = c.w;
    const ok = G.memberOk(w, member);
    if (ok !== true) throw new G.Err(400, 'INVALID_ARGUMENT', ok);
    if (!G.ROLES[role] && !(w.customRoles || {})[role]) throw new G.Err(400, 'INVALID_ARGUMENT', `Role ${role} is not supported for this resource.`);
    if (!G.domainOk(w, resName, member)) throw new G.Err(400, 'FAILED_PRECONDITION', 'One or more users named in the policy do not belong to a permitted customer,  perhaps due to an organization policy.');
    if (opts.check) opts.check(member, role);
    const pol = w.policies[resName] = w.policies[resName] || { version: 1, etag: 'ACAB', bindings: [] };
    const condKey = cond ? JSON.stringify(cond) : '';
    let b = pol.bindings.find((x) => x.role === role && (x.condition ? JSON.stringify(x.condition) : '') === condKey);
    if (!b) { b = { role, members: [] }; if (cond) b.condition = cond; pol.bindings.push(b); }
    if (!b.members.includes(member)) b.members.push(member);
    if (cond) pol.version = 3;
    bumpEtag(w, pol);
    return pol;
  };
  G.iamCmds = (group, o) => {
    // o = { pos, res(c) → { name, project, svc, getPerm, setPerm, kind, label }, fmtAdd? }
    G.gc(group + ' get-iam-policy', { pos: [o.pos], flags: o.flags || {}, fmt: 'yaml', run: async (c) => {
      const r = o.res(c);
      c.call({ method: 'GetIamPolicy', perm: r.getPerm, res: r.name, svc: r.svc, project: r.project, read: true, url: r.url ? r.url + ':getIamPolicy' : undefined, verb: 'POST', resPretty: r.pretty });
      const pol = c.w.policies[r.name] || { version: 1, etag: 'ACAB', bindings: [] };
      return G.policyView(pol);
    } });
    G.gc(group + ' add-iam-policy-binding', { pos: [o.pos], flags: Object.assign({ member: 'v', role: 'v', condition: 'v', 'condition-from-file': 'v' }, o.flags || {}), req: ['member', 'role'], fmt: 'yaml', run: async (c) => {
      const r = o.res(c);
      c.call({ method: 'SetIamPolicy', perm: r.setPerm, res: r.name, svc: r.svc, project: r.project, url: r.url ? r.url + ':setIamPolicy' : undefined, verb: 'POST', resPretty: r.pretty, resType: r.resType });
      const pol = G.addBinding(c, r.name, r.kind, r.label, c.a.member, c.a.role, parseCondition(c.a.condition), { check: r.check });
      c.err(`Updated IAM policy for ${r.kind} [${r.label}].\n`);
      return G.policyView(pol);
    } });
    G.gc(group + ' remove-iam-policy-binding', { pos: [o.pos], flags: Object.assign({ member: 'v', role: 'v', condition: 'v', all: 'b' }, o.flags || {}), req: ['member', 'role'], fmt: 'yaml', run: async (c) => {
      const r = o.res(c);
      c.call({ method: 'SetIamPolicy', perm: r.setPerm, res: r.name, svc: r.svc, project: r.project, resPretty: r.pretty, resType: r.resType });
      const pol = c.w.policies[r.name];
      const b = pol && pol.bindings.find((x) => x.role === c.a.role && x.members.includes(c.a.member));
      if (!b) throw E.plain(`Policy binding with the specified principal, role, and condition not found!`);
      let removed = false;
      for (const x of pol.bindings) if (x.role === c.a.role && (c.a.all || !x.condition || c.a.condition) && x.members.includes(c.a.member)) { x.members = x.members.filter((m) => m !== c.a.member); removed = true; }
      if (!removed) throw E.plain(`Policy binding with the specified principal, role, and condition not found! Specify --condition or --all to remove a conditional binding.`);
      pol.bindings = pol.bindings.filter((x) => x.members.length);
      bumpEtag(c.w, pol);
      c.err(`Updated IAM policy for ${r.kind} [${r.label}].\n`);
      return G.policyView(pol);
    } });
    G.gc(group + ' set-iam-policy', { pos: [o.pos, 'POLICY_FILE'], flags: o.flags || {}, fmt: 'yaml', run: async (c) => {
      const r = o.res(c);
      const s = G.fs.read(c.sys, c.p[1]);
      if (s === null) throw E.plain(`Unable to read file [${c.p[1]}]: [Errno 2] No such file or directory: '${c.p[1]}'`);
      let np; try { np = G.parseYamlOrJson(s); } catch (e) { throw E.plain(`Failed to load YAML from [${c.p[1]}]: ${e.message}`); }
      c.call({ method: 'SetIamPolicy', perm: r.setPerm, res: r.name, svc: r.svc, project: r.project, resType: r.resType });
      const cur = c.w.policies[r.name] || { etag: 'ACAB', bindings: [] };
      if (np.etag && np.etag !== cur.etag) throw new G.Err(409, 'ABORTED', 'There were concurrent policy changes. Please retry the whole read-modify-write with exponential backoff. The request\'s ETag \'' + np.etag + '\' did not match the current policy\'s ETag \'' + cur.etag + '\'.');
      for (const b of np.bindings || []) for (const m of b.members || []) {
        const ok = G.memberOk(c.w, m); if (ok !== true) throw new G.Err(400, 'INVALID_ARGUMENT', ok);
        if (!G.domainOk(c.w, r.name, m)) throw new G.Err(400, 'FAILED_PRECONDITION', 'One or more users named in the policy do not belong to a permitted customer,  perhaps due to an organization policy.');
      }
      const pol = { version: np.version || 1, etag: cur.etag, bindings: (np.bindings || []).map((b) => Object.assign({ role: b.role, members: b.members.slice() }, b.condition ? { condition: b.condition } : {})) };
      bumpEtag(c.w, pol);
      c.w.policies[r.name] = pol;
      c.err(`Updated IAM policy for ${r.kind} [${r.label}].\n`);
      return G.policyView(pol);
    } });
  };
  G.iamCmds('projects', { pos: 'PROJECT_ID', res: (c) => {
    const id = resolveProject(c.w, c.p[0]);
    if (!c.w.projects[id] || c.w.projects[id].lifecycleState !== 'ACTIVE') throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access projects instance [${c.p[0]}] (or it may not exist): The caller does not have permission` });
    return { name: 'projects/' + id, project: id, svc: 'cloudresourcemanager.googleapis.com', getPerm: 'resourcemanager.projects.getIamPolicy', setPerm: 'resourcemanager.projects.setIamPolicy', kind: 'project', label: id, resType: 'project', url: `https://cloudresourcemanager.googleapis.com/v1/projects/${id}` };
  } });

  // ---------------------------------------------------------------- organizations
  const orgView = (w) => ({ creationTime: w.org.createTime, directoryCustomerId: w.org.directoryCustomerId, displayName: w.org.displayName, lifecycleState: 'ACTIVE', name: 'organizations/' + w.org.id, owner: { directoryCustomerId: w.org.directoryCustomerId } });
  G.gc('organizations list', { fmt: 'table(displayName, name.segment():label=ID, owner.directoryCustomerId:label=DIRECTORY_CUSTOMER_ID)', run: async (c) => {
    const who = c.as();
    const kind = c.w.people[who] ? c.w.people[who].kind : 'sa';
    if (kind === 'consumer') return [];
    if (!G.check(c.w, who, 'resourcemanager.organizations.get', 'organizations/' + G.ORG_ID).ok) return [];
    return [orgView(c.w)];
  } });
  G.gc('organizations describe', { pos: ['ORGANIZATION'], fmt: 'yaml', run: async (c) => {
    const id = c.p[0].replace(/^organizations\//, '');
    if (id !== G.ORG_ID && id !== G.DOMAIN) throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access organizations instance [${id}] (or it may not exist): The caller does not have permission` });
    return orgView(c.w);
  } });
  G.iamCmds('organizations', { pos: 'ORGANIZATION', res: (c) => {
    const id = c.p[0].replace(/^organizations\//, '');
    if (id !== G.ORG_ID) throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access organizations instance [${id}] (or it may not exist): The caller does not have permission` });
    return { name: 'organizations/' + id, project: null, svc: '', getPerm: 'resourcemanager.organizations.getIamPolicy', setPerm: 'resourcemanager.organizations.setIamPolicy', kind: 'organization', label: id };
  } });

  // ---------------------------------------------------------------- folders
  const folderView = (f) => ({ createTime: f.createTime, displayName: f.displayName, lifecycleState: f.lifecycleState, name: 'folders/' + f.id, parent: f.parent });
  const parentArg = (c) => (c.a.folder ? 'folders/' + c.a.folder : c.a.organization ? 'organizations/' + c.a.organization : null);
  G.gc('resource-manager folders create', { flags: { 'display-name': 'v', folder: 'v', organization: 'v', async: 'b' }, req: ['display-name'], run: async (c) => {
    const parent = parentArg(c);
    if (!parent) throw E.usage('Exactly one of (--folder | --organization) must be specified.');
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,28}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u.test(c.a['display-name'])) throw new G.Err(400, 'INVALID_ARGUMENT', `Folder display name '${c.a['display-name']}' is invalid. Display names can contain letters, digits, spaces, hyphens and underscores, can be no longer than 30 characters, and must start and end with a letter or digit.`, { raw: false });
    if (parent.startsWith('folders/') && !c.w.folders[parent.slice(8)]) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Permission 'resourcemanager.folders.create' denied on resource '//cloudresourcemanager.googleapis.com/${parent}' (or it may not exist).` });
    if (G.ancestry(c.w, parent).length > 10) throw new G.Err(400, 'FAILED_PRECONDITION', 'Folder depth limit exceeded.');
    c.call({ method: 'CreateFolder', perm: 'resourcemanager.folders.create', res: parent, svc: 'cloudresourcemanager.googleapis.com', project: null, resPretty: '//cloudresourcemanager.googleapis.com/' + parent });
    const sib = Object.values(c.w.folders).find((f) => f.parent === parent && f.displayName === c.a['display-name'] && f.lifecycleState === 'ACTIVE');
    if (sib) throw new G.Err(400, 'FAILED_PRECONDITION', `A folder with the same name already exists under the parent resource.`, { detail: `- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - description: The folder operation violates display name uniqueness within the parent.\n    subject: ${c.a['display-name']}\n    type: FOLDER_NAME_UNIQUENESS_VIOLATION` });
    const id = G.digits('folder:' + c.a['display-name'] + ':' + parent + ':' + G.seq(c.w, 'folder'), 12);
    c.w.folders[id] = { id, displayName: c.a['display-name'], parent, lifecycleState: 'ACTIVE', createTime: G.iso(c.w.t) };
    G.tick(c.w, 3000);
    c.err(`Waiting for [${opName(c.w, 'cf')}] to finish...done.\n`);
    c.err(`Created [<Folder\n createTime: '${G.iso(c.w.t - 3000).replace(/\.\d+Z/, 'Z')}'\n displayName: '${c.a['display-name']}'\n lifecycleState: LifecycleStateValueValuesEnum(ACTIVE, 1)\n name: 'folders/${id}'\n parent: '${parent}'>].\n`);
  } });
  G.gc('resource-manager folders list', { flags: { folder: 'v', organization: 'v' }, fmt: 'table(displayName, parent:label=PARENT_NAME, name.segment():label=ID)', run: async (c) => {
    const parent = parentArg(c);
    if (!parent) throw E.usage('Exactly one of (--folder | --organization) must be specified.');
    c.call({ method: 'ListFolders', perm: 'resourcemanager.folders.list', res: parent, svc: '', read: true, project: null, resPretty: '//cloudresourcemanager.googleapis.com/' + parent });
    return Object.values(c.w.folders).filter((f) => f.parent === parent && f.lifecycleState === 'ACTIVE').sort((a, b) => (a.displayName < b.displayName ? -1 : 1)).map(folderView);
  } });
  const getFolder = (c, id, perm) => {
    id = String(id).replace(/^folders\//, '');
    const f = c.w.folders[id];
    if (!f) throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access folders instance [${id}] (or it may not exist): The caller does not have permission` });
    if (perm && f.lifecycleState !== 'ACTIVE') throw new G.Err(400, 'FAILED_PRECONDITION', `Folder ${id} is not in ACTIVE state.`);
    c.call({ method: 'GetFolder', perm: perm || 'resourcemanager.folders.get', res: 'folders/' + id, read: !perm, svc: '', project: null, resPretty: '//cloudresourcemanager.googleapis.com/folders/' + id });
    return f;
  };
  G.gc('resource-manager folders describe', { pos: ['FOLDER_ID'], fmt: 'yaml', run: async (c) => folderView(getFolder(c, c.p[0])) });
  G.gc('resource-manager folders delete', { pos: ['FOLDER_ID'], run: async (c) => {
    const f = getFolder(c, c.p[0], 'resourcemanager.folders.delete');
    const kids = Object.values(c.w.folders).some((x) => x.parent === 'folders/' + f.id && x.lifecycleState === 'ACTIVE') || Object.values(c.w.projects).some((p) => p.parent && p.parent.type === 'folder' && p.parent.id === f.id && p.lifecycleState !== 'DELETED');
    if (kids) throw new G.Err(400, 'FAILED_PRECONDITION', `Folder ${f.id} is not empty and cannot be deleted.`, { detail: `- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - description: The folder operation violates non-empty folder deletion constraints.\n    subject: folders/${f.id}\n    type: FOLDER_TO_DELETE_NON_EMPTY_VIOLATION` });
    f.lifecycleState = 'DELETE_REQUESTED';
    c.err(`Waiting for [${opName(c.w, 'df')}] to finish...done.\nDeleted [folders/${f.id}].\n`);
  } });
  G.gc('resource-manager folders move', { pos: ['FOLDER_ID'], flags: { folder: 'v', organization: 'v' }, run: async (c) => {
    const f = getFolder(c, c.p[0], 'resourcemanager.folders.move');
    const dest = parentArg(c);
    if (!dest) throw E.usage('Exactly one of (--folder | --organization) must be specified.');
    if (G.ancestry(c.w, dest).includes('folders/' + f.id)) throw new G.Err(400, 'FAILED_PRECONDITION', 'The folder move would create a cycle.');
    f.parent = dest;
    c.err(`Waiting for [${opName(c.w, 'mf')}] to finish...done.\n`);
    c.out(G.toYAML(folderView(f)) + '\n');
  } });
  G.iamCmds('resource-manager folders', { pos: 'FOLDER_ID', res: (c) => {
    const id = c.p[0].replace(/^folders\//, '');
    if (!c.w.folders[id]) throw new G.Err(403, '', '', { gcloud: `[${c.as()}] does not have permission to access folders instance [${id}] (or it may not exist): The caller does not have permission` });
    return { name: 'folders/' + id, project: null, svc: '', getPerm: 'resourcemanager.folders.getIamPolicy', setPerm: 'resourcemanager.folders.setIamPolicy', kind: 'folder', label: id };
  } });

  // ---------------------------------------------------------------- services（API の有効化）
  G.gc('services list', { flags: { enabled: 'b', available: 'b' }, fmt: 'table(config.name:label=NAME:sort=1, config.title:label=TITLE)', run: async (c) => {
    const pid = c.need();
    const p = getProject(c, pid, 'serviceusage.services.list');
    const names = c.a.available ? Object.keys(G.APIS) : p.services;
    return names.slice().sort().map((n) => ({ config: { name: n, title: G.APIS[n] || n }, name: `projects/${p.projectNumber}/services/${n}`, state: p.services.includes(n) ? 'ENABLED' : 'DISABLED', parent: 'projects/' + p.projectNumber }));
  } });
  G.enableApi = (w, p, names) => {
    const all = [];
    const add = (n) => { if (!all.includes(n)) { all.push(n); for (const d of G.API_DEPS[n] || []) add(d); } };
    for (const n of names) add(n);
    for (const n of all) if (!p.services.includes(n)) { p.services.push(n); if (G.ON_ENABLE[n]) G.ON_ENABLE[n](w, p); }
  };
  G.ON_ENABLE = G.ON_ENABLE || {};
  G.gc('services enable', { pos: ['SERVICE …'], flags: { async: 'b' }, run: async (c) => {
    const pid = c.need();
    if (!c.p.length) throw E.usage('argument SERVICE: Must be specified.');
    const p = getProject(c, pid, 'serviceusage.services.enable');
    const unknown = c.p.filter((n) => !G.APIS[n]);
    if (unknown.length) throw new G.Err(403, 'PERMISSION_DENIED', `Not found or permission denied for service(s): ${unknown.join(',')}.`, { detail: `Help Token: A${G.alnum('ht' + unknown, 40)}\n- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - subject: ?error_code=220002&services=${unknown[0]}\n    type: googleapis.com\n- '@type': type.googleapis.com/google.rpc.ErrorInfo\n  domain: serviceusage.googleapis.com\n  metadata:\n    services: ${unknown[0]}\n  reason: SERVICE_CONFIG_NOT_FOUND_OR_PERMISSION_DENIED` });
    c.call({ method: 'google.api.serviceusage.v1.ServiceUsage.EnableService', perm: 'serviceusage.services.enable', res: 'projects/' + pid, svc: 'serviceusage.googleapis.com', project: pid, resType: 'audited_resource', url: `https://serviceusage.googleapis.com/v1/projects/${pid}/services:batchEnable?alt=json`, verb: 'POST', body: { serviceIds: c.p } });
    const billed = c.p.filter((n) => G.NEEDS_BILLING.has(n) && !p.services.includes(n));
    if (billed.length && !p.billing) throw new G.Err(400, 'FAILED_PRECONDITION', `Billing account for project '${p.projectNumber}' is not found. Billing must be enabled for activation of service(s) '${billed.join(',')}' to proceed.`, { detail: `Help Token: A${G.alnum('bill' + pid, 40)}\n- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - subject: ?error_code=390001&project=${p.projectNumber}&services=${billed.join(',')}\n    type: googleapis.com/billing-enabled\n- '@type': type.googleapis.com/google.rpc.ErrorInfo\n  domain: serviceusage.googleapis.com/billing-enabled\n  metadata:\n    project: '${p.projectNumber}'\n    services: ${billed.join(',')}\n  reason: UREQ_PROJECT_BILLING_NOT_FOUND` });
    G.enableApi(c.w, p, c.p);
    G.tick(c.w, 20000);
    c.err(`Operation "operations/acf.p2-${p.projectNumber}-${G.uuid('acf' + G.seq(c.w, 'acf'))}" finished successfully.\n`);
  } });
  G.gc('services disable', { pos: ['SERVICE …'], flags: { force: 'b', async: 'b' }, run: async (c) => {
    const pid = c.need();
    const p = getProject(c, pid, 'serviceusage.services.disable');
    for (const n of c.p) {
      const dependents = p.services.filter((x) => (G.API_DEPS[x] || []).includes(n));
      if (dependents.length && !c.a.force) throw new G.Err(400, 'FAILED_PRECONDITION', `The service ${n} is depended on by the following active service(s): ${dependents.join(',')}; Please specify disable_dependent_services=true if you want to proceed with disabling all services.`);
      c.call({ method: 'google.api.serviceusage.v1.ServiceUsage.DisableService', perm: 'serviceusage.services.disable', res: 'projects/' + pid, svc: 'serviceusage.googleapis.com', project: pid });
      p.services = p.services.filter((x) => x !== n && !(c.a.force && dependents.includes(x)));
    }
    c.err(`Operation "operations/acat.p2-${p.projectNumber}-${G.uuid('acd' + G.seq(c.w, 'acf'))}" finished successfully.\n`);
  } });

  // ---------------------------------------------------------------- billing
  const billView = (b) => ({ displayName: b.displayName, masterBillingAccount: b.masterBillingAccount, name: 'billingAccounts/' + b.id, open: b.open, currencyCode: b.currencyCode });
  const billId = (s) => String(s || '').replace(/^billingAccounts\//, '');
  G.gc('billing accounts list', { flags: { filter: 'v' }, fmt: 'table(name.basename():label=ACCOUNT_ID, displayName:label=NAME, open, masterBillingAccount.basename():label=MASTER_ACCOUNT_ID)', run: async (c) => {
    const who = c.as();
    return Object.values(c.w.billing).filter((b) => G.check(c.w, who, 'billing.accounts.get', 'billingAccounts/' + b.id).ok).map(billView);
  } });
  G.gc('billing accounts describe', { pos: ['ACCOUNT_ID'], fmt: 'yaml', run: async (c) => {
    const b = c.w.billing[billId(c.p[0])];
    if (!b || !G.check(c.w, c.as(), 'billing.accounts.get', 'billingAccounts/' + b.id).ok) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    return billView(b);
  } });
  G.iamCmds('billing accounts', { pos: 'ACCOUNT_ID', res: (c) => {
    const id = billId(c.p[0]);
    if (!c.w.billing[id]) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    return { name: 'billingAccounts/' + id, project: null, svc: '', pretty: '//cloudbilling.googleapis.com/billingAccounts/' + id, getPerm: 'billing.accounts.getIamPolicy', setPerm: 'billing.accounts.setIamPolicy', kind: 'billing account', label: id };
  } });
  const billingInfo = (p) => ({ billingAccountName: p.billing ? 'billingAccounts/' + p.billing : '', billingEnabled: !!p.billing, name: `projects/${p.projectId}/billingInfo`, projectId: p.projectId });
  G.gc('billing projects describe', { pos: ['PROJECT_ID'], fmt: 'yaml', run: async (c) => billingInfo(getProject(c, c.p[0])) });
  G.gc('billing projects link', { pos: ['PROJECT_ID'], flags: { 'billing-account': 'v' }, req: ['billing-account'], fmt: 'yaml', run: async (c) => {
    const p = getProject(c, c.p[0]);
    const id = billId(c.a['billing-account']);
    const b = c.w.billing[id];
    const who = c.as();
    if (!b || !G.check(c.w, who, 'billing.resourceAssociations.create', 'billingAccounts/' + id).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: The caller does not have permission. This command is authenticated as ${who} which is the active account specified by the [core/account] property` });
    if (!G.check(c.w, who, 'resourcemanager.projects.createBillingAssignment', 'projects/' + p.projectId).ok) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: The caller does not have permission. This command is authenticated as ${who} which is the active account specified by the [core/account] property` });
    if (!b.open) throw new G.Err(400, 'FAILED_PRECONDITION', 'Precondition check failed.');
    p.billing = id;
    G.audit(c.w, { project: p.projectId, who, method: 'AssignResourceToBillingAccount', perm: 'billing.resourceAssociations.create', res: 'billingAccounts/' + id, svc: 'cloudbilling.googleapis.com' });
    G.tick(c.w, 1500);
    return billingInfo(p);
  } });
  G.gc('billing projects unlink', { pos: ['PROJECT_ID'], fmt: 'yaml', run: async (c) => {
    const p = getProject(c, c.p[0]);
    if (!G.check(c.w, c.as(), 'resourcemanager.projects.deleteBillingAssignment', 'projects/' + p.projectId).ok) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    p.billing = '';
    // 請求先がなくなると、課金のあるリソースは止まる
    if (G.ON_UNBILL) for (const f of Object.values(G.ON_UNBILL)) f(c.w, p);
    return billingInfo(p);
  } });
  G.ON_UNBILL = G.ON_UNBILL || {};
  G.gc('billing projects list', { flags: { 'billing-account': 'v' }, req: ['billing-account'], fmt: 'table(projectId, billingAccountName.basename():label=BILLING_ACCOUNT_ID, billingEnabled)', run: async (c) => {
    const id = billId(c.a['billing-account']);
    if (!c.w.billing[id] || !G.check(c.w, c.as(), 'billing.accounts.get', 'billingAccounts/' + id).ok) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    return Object.values(c.w.projects).filter((p) => p.billing === id && p.lifecycleState === 'ACTIVE').sort((a, b) => (a.projectId < b.projectId ? -1 : 1)).map(billingInfo);
  } });
  // 予算（Budget）
  const budgetView = (bid, b) => ({
    amount: b.last ? { lastPeriodAmount: {} } : { specifiedAmount: { currencyCode: b.currency, units: String(b.amount) } },
    budgetFilter: Object.assign({ creditTypesTreatment: 'INCLUDE_ALL_CREDITS' }, b.projects.length ? { projects: b.projects.map((x) => 'projects/' + x) } : {}, { calendarPeriod: 'MONTH' }),
    displayName: b.displayName, etag: G.hex('bud' + b.id, 16), name: `billingAccounts/${bid}/budgets/${b.id}`,
    thresholdRules: b.thresholds.map((t) => ({ spendBasis: t.basis || 'CURRENT_SPEND', thresholdPercent: t.percent })),
  });
  G.gc('billing budgets create', { flags: { 'billing-account': 'v', 'display-name': 'v', 'budget-amount': 'v', 'threshold-rule': 'v*', 'filter-projects': 'v', 'last-period-amount': 'b', 'calendar-period': 'v' }, req: ['billing-account', 'display-name'], fmt: 'yaml', run: async (c) => {
    const id = billId(c.a['billing-account']);
    const b = c.w.billing[id];
    if (!b || !G.check(c.w, c.as(), 'billing.budgets.create', 'billingAccounts/' + id).ok) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    const m = c.a['last-period-amount'] ? ['', '0', ''] : String(c.a['budget-amount'] || '').match(/^([\d.]+)([A-Z]{3})?$/);
    if (!m) throw E.usage('Exactly one of (--budget-amount | --last-period-amount) must be specified.');
    if (m[2] && m[2] !== b.currencyCode) throw new G.Err(400, 'INVALID_ARGUMENT', `Budget currency code ${m[2]} does not match the billing account's currency code ${b.currencyCode}.`);
    const thresholds = (c.a['threshold-rule'] || []).map((s) => { const o = {}; for (const kv of s.split(',')) { const [k, v] = kv.split('='); o[k] = v; } return { percent: Number(o.percent), basis: o['basis'] === 'forecasted-spend' ? 'FORECASTED_SPEND' : 'CURRENT_SPEND' }; });
    const bud = { id: G.uuid('budget' + G.seq(c.w, 'budget')), displayName: c.a['display-name'], last: !!c.a['last-period-amount'], amount: Number(m[1]), currency: b.currencyCode, thresholds, projects: (c.a['filter-projects'] || '').split(',').filter(Boolean).map((x) => resolveProject(c.w, x.replace(/^projects\//, ''))) };
    b.budgets.push(bud);
    c.err(`Created budget [${bud.id}].\n`);
    return budgetView(id, bud);
  } });
  G.gc('billing budgets list', { flags: { 'billing-account': 'v' }, req: ['billing-account'], fmt: 'table(displayName, amount.specifiedAmount.units:label=AMOUNT, amount.specifiedAmount.currencyCode:label=CURRENCY, name.basename():label=BUDGET_ID)', run: async (c) => {
    const id = billId(c.a['billing-account']);
    const b = c.w.billing[id];
    if (!b || !G.check(c.w, c.as(), 'billing.accounts.get', 'billingAccounts/' + id).ok) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    return b.budgets.map((x) => budgetView(id, x));
  } });
  G.gc('billing budgets describe', { pos: ['BUDGET'], flags: { 'billing-account': 'v' }, req: ['billing-account'], fmt: 'yaml', run: async (c) => {
    const id = billId(c.a['billing-account']);
    const b = c.w.billing[id];
    const x = b && b.budgets.find((y) => y.id === G.basename(c.p[0]));
    if (!x) throw new G.Err(404, 'NOT_FOUND', 'Requested entity was not found.');
    return budgetView(id, x);
  } });
  G.gc('billing budgets delete', { pos: ['BUDGET'], flags: { 'billing-account': 'v' }, req: ['billing-account'], run: async (c) => {
    const id = billId(c.a['billing-account']);
    const b = c.w.billing[id];
    const k = b ? b.budgets.findIndex((y) => y.id === G.basename(c.p[0])) : -1;
    if (k < 0) throw new G.Err(404, 'NOT_FOUND', 'Requested entity was not found.');
    b.budgets.splice(k, 1);
    c.err(`Deleted budget [billingAccounts/${id}/budgets/${G.basename(c.p[0])}].\n`);
  } });

  // ---------------------------------------------------------------- iam service-accounts
  const saView = (s, pid) => ({ disabled: !!s.disabled || undefined, displayName: s.displayName || undefined, description: s.description || undefined, email: s.email, etag: 'MDEwMjE5MjA=', name: `projects/${pid}/serviceAccounts/${s.email}`, oauth2ClientId: s.uid, projectId: pid, uniqueId: s.uid });
  G.saView = saView;
  G.addSa = (w, pid, name, o = {}) => {
    const p = w.projects[pid];
    p.sas = p.sas || {};
    const email = o.email || G.saEmail(name, pid);
    if (p.sas[email]) return p.sas[email];
    const s = { email, displayName: o.displayName || '', description: o.description || '', uid: G.digits('sa:' + email, 21), keys: [], disabled: false, managed: !!o.managed, createTime: G.iso(w.t) };
    p.sas[email] = s;
    return s;
  };
  const getSa = (c, email, perm) => {
    const pid = c.need();
    if (!email.includes('@')) email = G.saEmail(email, pid);
    const f = G.findSa(c.w, email);
    if (!f || f.sa.deleted) throw new G.Err(404, 'NOT_FOUND', `Unknown service account`, { gcloud: `NOT_FOUND: Unknown service account` });
    c.call({ method: 'google.iam.admin.v1.GetServiceAccount', perm: perm || 'iam.serviceAccounts.get', res: `projects/${f.project}/serviceAccounts/${email}`, svc: 'iam.googleapis.com', project: f.project, read: !perm, resPretty: `iam.googleapis.com/projects/${f.project}/serviceAccounts/${email}` });
    return f;
  };
  G.gc('iam service-accounts create', { pos: ['NAME'], flags: { 'display-name': 'v', description: 'v' }, run: async (c) => {
    const pid = c.need();
    const name = c.p[0];
    if (!/^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$/.test(name)) throw E.usage(`argument NAME: Bad value [${name}]: Service account name must be between 6 and 30 characters (inclusive), must begin with a lowercase letter, and consist of lowercase alphanumeric characters that can be separated by hyphens.`);
    c.call({ method: 'google.iam.admin.v1.CreateServiceAccount', perm: 'iam.serviceAccounts.create', res: 'projects/' + pid, svc: 'iam.googleapis.com', project: pid, resType: 'service_account', url: `https://iam.googleapis.com/v1/projects/${pid}/serviceAccounts?alt=json`, verb: 'POST', body: { accountId: name, serviceAccount: { displayName: c.a['display-name'] } } });
    const email = G.saEmail(name, pid);
    if ((c.w.projects[pid].sas || {})[email] && !c.w.projects[pid].sas[email].deleted) throw new G.Err(409, 'ALREADY_EXISTS', '', { gcloud: `Resource in projects [${pid}] is the subject of a conflict: Service account ${name} already exists within project projects/${pid}.` });
    if ((c.w.projects[pid].sas || {})[email]) delete c.w.projects[pid].sas[email];
    G.addSa(c.w, pid, name, { displayName: c.a['display-name'], description: c.a.description });
    c.err(`Created service account [${name}].\n`);
  } });
  G.gc('iam service-accounts list', { fmt: 'table(displayName:label="DISPLAY NAME", email, disabled)', run: async (c) => {
    const pid = c.need();
    getProject(c, pid, 'iam.serviceAccounts.list');
    const p = c.w.projects[pid];
    if (!p.services.includes('iam.googleapis.com')) c.call({ svc: 'iam.googleapis.com', project: pid });
    return Object.values(p.sas || {}).filter((s) => !s.deleted && !s.managed).sort((a, b) => (a.email < b.email ? -1 : 1)).map((s) => Object.assign(saView(s, pid), { disabled: !!s.disabled }));
  } });
  G.gc('iam service-accounts describe', { pos: ['SERVICE_ACCOUNT'], fmt: 'yaml', run: async (c) => { const f = getSa(c, c.p[0]); return saView(f.sa, f.project); } });
  G.gc('iam service-accounts delete', { pos: ['SERVICE_ACCOUNT'], run: async (c) => {
    const f = getSa(c, c.p[0], 'iam.serviceAccounts.delete');
    c.confirm(`You are about to delete service account [${f.sa.email}].`);
    f.sa.deleted = true;
    c.err(`deleted service account [${f.sa.email}]\n`);
  } });
  G.gc('iam service-accounts disable', { pos: ['SERVICE_ACCOUNT'], run: async (c) => { const f = getSa(c, c.p[0], 'iam.serviceAccounts.disable'); f.sa.disabled = true; c.err(`Disabled service account [${f.sa.email}].\n`); } });
  G.gc('iam service-accounts enable', { pos: ['SERVICE_ACCOUNT'], run: async (c) => { const f = getSa(c, c.p[0], 'iam.serviceAccounts.enable'); f.sa.disabled = false; c.err(`Enabled service account [${f.sa.email}].\n`); } });
  G.iamCmds('iam service-accounts', { pos: 'SERVICE_ACCOUNT', res: (c) => {
    const f = getSa(c, c.p[0]);
    return { name: `projects/${f.project}/serviceAccounts/${f.sa.email}`, project: f.project, svc: 'iam.googleapis.com', getPerm: 'iam.serviceAccounts.getIamPolicy', setPerm: 'iam.serviceAccounts.setIamPolicy', kind: 'serviceAccount', label: f.sa.email };
  } });
  G.gc('iam service-accounts keys create', { pos: ['OUTPUT-FILE'], flags: { 'iam-account': 'v', 'key-file-type': 'v' }, req: ['iam-account'], run: async (c) => {
    const f = getSa(c, c.a['iam-account'], 'iam.serviceAccountKeys.create');
    const pol = G.orgPolicyOf(c.w, 'projects/' + f.project, 'iam.disableServiceAccountKeyCreation');
    if (pol && pol.spec.rules && pol.spec.rules[0].enforce) throw new G.Err(400, 'FAILED_PRECONDITION', 'Key creation is not allowed on this service account.', { detail: `- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - description: Key creation is not allowed on this service account.\n    subject: projects/${f.project}/serviceAccounts/${f.sa.email}?configvalue=${f.sa.email}\n    type: constraints/iam.disableServiceAccountKeyCreation` });
    const id = G.hex('key' + f.sa.email + G.seq(c.w, 'key'), 40);
    f.sa.keys.push({ id, created: G.iso(c.w.t, 0), type: 'USER_MANAGED' });
    const key = { type: 'service_account', project_id: f.project, private_key_id: id, private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC…（このサイトでは中身は作りません）\n-----END PRIVATE KEY-----\n', client_email: f.sa.email, client_id: f.sa.uid, auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', universe_domain: 'googleapis.com' };
    G.fs.write(c.sys, c.p[0], JSON.stringify(key, null, 2) + '\n');
    c.err(`created key [${id}] of type [json] as [${c.p[0]}] for [${f.sa.email}]\n`);
  } });
  G.gc('iam service-accounts keys list', { flags: { 'iam-account': 'v', managed: 'b' }, req: ['iam-account'], fmt: 'table(name.basename():label=KEY_ID, validAfterTime:label=CREATED_AT, validBeforeTime:label=EXPIRES_AT, disabled)', run: async (c) => {
    const f = getSa(c, c.a['iam-account']);
    const sys = { name: G.hex('sys' + f.sa.email, 40), validAfterTime: f.sa.createTime.replace(/\.\d+Z/, 'Z'), validBeforeTime: '2028-11-20T09:00:00Z', keyType: 'SYSTEM_MANAGED' };
    const user = f.sa.keys.filter((k) => !k.deleted).map((k) => ({ name: k.id, validAfterTime: k.created, validBeforeTime: '9999-12-31T23:59:59Z', keyType: 'USER_MANAGED' }));
    return [sys].concat(user).filter((k) => !c.a.managed || k.keyType === 'USER_MANAGED').map((k) => Object.assign(k, { disabled: false }));
  } });
  G.gc('iam service-accounts keys delete', { pos: ['KEY_ID'], flags: { 'iam-account': 'v' }, req: ['iam-account'], run: async (c) => {
    const f = getSa(c, c.a['iam-account'], 'iam.serviceAccountKeys.delete');
    const k = f.sa.keys.find((x) => x.id === c.p[0] && !x.deleted);
    if (!k) throw new G.Err(404, 'NOT_FOUND', '', { gcloud: `NOT_FOUND: Unknown service account key` });
    c.confirm(`You are about to delete key [${c.p[0]}] for service account [${f.sa.email}].`);
    k.deleted = true;
    c.err(`deleted key [${c.p[0]}] for service account [${f.sa.email}]\n`);
  } });

  // ---------------------------------------------------------------- iam roles
  const roleView = (w, name) => {
    const r = G.ROLES[name] || (w.customRoles || {})[name];
    return { description: r.description, etag: r.etag || 'AA==', includedPermissions: G.permsOf(w, name), name, stage: r.stage || 'GA', title: r.title };
  };
  G.gc('iam roles describe', { pos: ['ROLE_ID'], flags: { project: 'v', organization: 'v' }, fmt: 'yaml', run: async (c) => {
    let name = c.p[0];
    if (!name.startsWith('roles/') && !name.includes('/roles/')) name = (c.a.project ? `projects/${c.a.project}/roles/` : c.a.organization ? `organizations/${c.a.organization}/roles/` : 'roles/') + name;
    if (!G.ROLES[name] && !(c.w.customRoles || {})[name]) throw new G.Err(404, 'NOT_FOUND', '', { gcloud: `NOT_FOUND: The role named ${name} was not found.` });
    return roleView(c.w, name);
  } });
  G.gc('iam roles list', { flags: { project: 'v', organization: 'v', 'show-deleted': 'b' }, fmt: 'yaml(description, etag, name, stage, title)', run: async (c) => {
    if (c.a.project) return Object.keys(c.w.customRoles || {}).filter((n) => n.startsWith(`projects/${c.a.project}/`)).map((n) => roleView(c.w, n)).map((r) => ({ description: r.description, etag: r.etag, name: r.name, stage: r.stage, title: r.title }));
    return Object.keys(G.ROLES).sort().map((n) => ({ description: G.ROLES[n].description, etag: 'AA==', name: n, stage: G.ROLES[n].stage, title: G.ROLES[n].title }));
  } });
  G.gc('iam roles create', { pos: ['ROLE_ID'], flags: { project: 'v', organization: 'v', title: 'v', description: 'v', permissions: 'v', stage: 'v', file: 'v' }, fmt: 'yaml', run: async (c) => {
    const parent = c.a.organization ? 'organizations/' + c.a.organization : 'projects/' + (c.a.project || c.need());
    if (!c.a.project && !c.a.organization) throw E.usage('Exactly one of (--organization | --project) must be specified.');
    if (!/^[a-zA-Z0-9_.]{3,64}$/.test(c.p[0])) throw new G.Err(400, 'INVALID_ARGUMENT', `The role id that you provide must be between 3 and 64 characters long and can contain only alphanumeric characters, underscores and periods.`);
    c.call({ method: 'google.iam.admin.v1.CreateRole', perm: 'iam.roles.create', res: parent, svc: 'iam.googleapis.com', project: c.a.project || null });
    const name = `${parent}/roles/${c.p[0]}`;
    c.w.customRoles = c.w.customRoles || {};
    if (c.w.customRoles[name]) throw new G.Err(409, 'ALREADY_EXISTS', `A role named ${c.p[0]} in ${parent} already exists.`);
    const perms = (c.a.permissions || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = perms.filter((p) => !/^[a-z]+\.[a-zA-Z]+\.[a-zA-Z]+$/.test(p));
    if (bad.length) throw new G.Err(400, 'INVALID_ARGUMENT', `Permission ${bad[0]} is not valid.`);
    c.w.customRoles[name] = { name, title: c.a.title || c.p[0], description: c.a.description || 'Created on: 2026-11-16', includedPermissions: perms.sort(), stage: c.a.stage || 'ALPHA', etag: 'BwY' + G.alnum('role' + name, 9) + '=' };
    for (const p of perms) G.KNOWN.add(p);
    c.err(`Created role [${c.p[0]}].\n`);
    return roleView(c.w, name);
  } });
  G.gc('iam roles update', { pos: ['ROLE_ID'], flags: { project: 'v', organization: 'v', 'add-permissions': 'v', 'remove-permissions': 'v', title: 'v', stage: 'v' }, fmt: 'yaml', run: async (c) => {
    const parent = c.a.organization ? 'organizations/' + c.a.organization : 'projects/' + (c.a.project || c.need());
    const name = `${parent}/roles/${c.p[0]}`;
    const r = (c.w.customRoles || {})[name];
    if (!r) throw new G.Err(404, 'NOT_FOUND', `The role named ${name} was not found.`);
    if (c.a['add-permissions']) for (const p of c.a['add-permissions'].split(',')) if (!r.includedPermissions.includes(p)) r.includedPermissions.push(p);
    if (c.a['remove-permissions']) r.includedPermissions = r.includedPermissions.filter((p) => !c.a['remove-permissions'].split(',').includes(p));
    r.includedPermissions.sort();
    if (c.a.title) r.title = c.a.title;
    if (c.a.stage) r.stage = c.a.stage;
    return roleView(c.w, name);
  } });

  // ---------------------------------------------------------------- org-policies（組織のポリシー）
  const CONSTRAINTS = {
    'iam.allowedPolicyMemberDomains': { list: true, title: 'Domain restricted sharing', desc: 'IAM ポリシーに追加できるプリンシパルを、指定した組織（Workspace / Cloud Identity の顧客 ID）のものに限る' },
    'iam.disableServiceAccountKeyCreation': { list: false, title: 'Disable service account key creation', desc: 'サービスアカウントの鍵（JSON の鍵ファイル）を作れなくする' },
    'storage.publicAccessPrevention': { list: false, title: 'Enforce Public Access Prevention', desc: 'Cloud Storage のデータを公開（allUsers / allAuthenticatedUsers）できなくする' },
    'gcp.resourceLocations': { list: true, title: 'Google Cloud Platform - Resource Location Restriction', desc: 'リソースを作れる場所（リージョン）を限る' },
    'compute.vmExternalIpAccess': { list: true, title: 'Define allowed external IPs for VM instances', desc: '外部 IP アドレスを持てる VM を限る' },
    'storage.uniformBucketLevelAccess': { list: false, title: 'Enforce uniform bucket-level access', desc: 'バケットに均一なバケットレベルのアクセスを強制する' },
    'iam.automaticIamGrantsForDefaultServiceAccounts': { list: false, title: 'Disable Automatic IAM Grants for Default Service Accounts', desc: '既定のサービスアカウントに Editor ロールを自動で付けない' },
  };
  G.CONSTRAINTS = CONSTRAINTS;
  const orgParent = (c) => {
    if (c.a.organization) return { name: 'organizations/' + c.a.organization, pretty: 'organizations/' + c.a.organization };
    if (c.a.folder) return { name: 'folders/' + c.a.folder, pretty: 'folders/' + c.a.folder };
    const pid = c.a.project || c.need();
    const p = c.w.projects[pid];
    if (!p) throw new G.Err(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    return { name: 'projects/' + pid, pretty: 'projects/' + p.projectNumber };
  };
  const cName = (s) => s.replace(/^constraints\//, '');
  G.gc('org-policies list', { flags: { organization: 'v', folder: 'v', project: 'v', 'show-unset': 'b' }, fmt: 'table(constraint:label=CONSTRAINT, listPolicy:label=LIST_POLICY, booleanPolicy:label=BOOLEAN_POLICY, etag)', run: async (c) => {
    const par = orgParent(c);
    const set = c.w.orgPolicies[par.name] || {};
    const names = c.a['show-unset'] ? Object.keys(CONSTRAINTS) : Object.keys(set).filter((k) => !k.startsWith('!'));
    return names.sort().map((n) => ({ constraint: n, listPolicy: CONSTRAINTS[n].list ? (set[n] ? 'SET' : '-') : '-', booleanPolicy: CONSTRAINTS[n].list ? '-' : (set[n] ? 'SET' : '-'), etag: set[n] ? set[n].etag : '-' }));
  } });
  G.gc('org-policies describe', { pos: ['CONSTRAINT'], flags: { organization: 'v', folder: 'v', project: 'v', effective: 'b' }, fmt: 'yaml', run: async (c) => {
    const par = orgParent(c);
    const n = cName(c.p[0]);
    if (!CONSTRAINTS[n]) throw new G.Err(400, 'INVALID_ARGUMENT', `Constraint 'constraints/${n}' is not a valid constraint.`);
    const pol = c.a.effective ? G.orgPolicyOf(c.w, par.name, n) : (c.w.orgPolicies[par.name] || {})[n];
    if (!pol) {
      if (c.a.effective) return { name: `${par.pretty}/policies/${n}`, spec: {} };
      throw new G.Err(404, 'NOT_FOUND', `Requested entity was not found.`);
    }
    return { name: `${par.pretty}/policies/${n}`, spec: Object.assign({ etag: pol.etag, updateTime: pol.updateTime }, pol.spec) };
  } });
  G.gc('org-policies set-policy', { pos: ['POLICY_FILE'], flags: { 'update-mask': 'v' }, fmt: 'yaml', run: async (c) => {
    const s = G.fs.read(c.sys, c.p[0]);
    if (s === null) throw E.plain(`Unable to read file [${c.p[0]}]: [Errno 2] No such file or directory: '${c.p[0]}'`);
    let pol; try { pol = G.parseYamlOrJson(s); } catch (e) { throw E.plain(`Unable to parse file [${c.p[0]}]: ${e.message}`); }
    const m = String(pol.name || '').match(/^(projects|folders|organizations)\/([^/]+)\/policies\/([\w.]+)$/);
    if (!m) throw new G.Err(400, 'INVALID_ARGUMENT', 'Invalid policy name: ' + pol.name);
    let resName = m[1] + '/' + m[2];
    if (m[1] === 'projects') resName = 'projects/' + resolveProject(c.w, m[2]);
    if (!CONSTRAINTS[m[3]]) throw new G.Err(400, 'INVALID_ARGUMENT', `Constraint 'constraints/${m[3]}' is not a valid constraint.`);
    const who = c.as();
    if (!G.check(c.w, who, 'orgpolicy.policies.create', resName).ok) throw new G.Err(403, 'PERMISSION_DENIED', `Permission 'orgpolicy.policies.create' denied on resource '//orgpolicy.googleapis.com/${pol.name}' (or it may not exist).`);
    const o = c.w.orgPolicies[resName] = c.w.orgPolicies[resName] || {};
    const etag = 'C' + G.alnum('op' + G.seq(c.w, 'op'), 10) + '=';
    o[m[3]] = { spec: pol.spec || {}, etag, updateTime: G.iso(c.w.t, 6) };
    if (pol.spec && pol.spec.reset) o[m[3]].reset = true;
    return { name: pol.name, spec: Object.assign({ etag, updateTime: G.iso(c.w.t, 6) }, pol.spec || {}) };
  } });
  G.gc('org-policies delete', { pos: ['CONSTRAINT'], flags: { organization: 'v', folder: 'v', project: 'v' }, run: async (c) => {
    const par = orgParent(c);
    const n = cName(c.p[0]);
    const o = c.w.orgPolicies[par.name] || {};
    if (!o[n]) throw new G.Err(404, 'NOT_FOUND', 'Requested entity was not found.');
    if (!G.check(c.w, c.as(), 'orgpolicy.policies.delete', par.name).ok) throw new G.Err(403, 'PERMISSION_DENIED', `Permission 'orgpolicy.policies.delete' denied on resource '//orgpolicy.googleapis.com/${par.pretty}/policies/${n}' (or it may not exist).`);
    delete o[n];
    c.err(`Deleted policy [${par.pretty}/policies/${n}].\n{}\n`);
  } });

  // ---------------------------------------------------------------- YAML を読む（ポリシーのファイル用。小さな部分集合）
  G.parseYamlOrJson = (s) => {
    const t = s.trim();
    if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
    return parseYaml(s);
  };
  function parseYaml(src) {
    const lines = src.split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/\s+$/, '')).filter((l) => l.trim() && l.trim() !== '---');
    let k = 0;
    const ind = (l) => l.match(/^ */)[0].length;
    const val = (s) => {
      s = s.trim();
      if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
      if (/^".*"$/.test(s)) return JSON.parse(s);
      if (s === 'true') return true; if (s === 'false') return false; if (s === 'null' || s === '~') return null;
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      if (s === '[]') return []; if (s === '{}') return {};
      if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => val(x)).filter((x) => x !== '');
      return s;
    };
    function block(level) {
      if (k >= lines.length) return null;
      if (lines[k].trim().startsWith('- ') || lines[k].trim() === '-') {
        const arr = [];
        const base = ind(lines[k]);
        while (k < lines.length && ind(lines[k]) === base && /^ *-( |$)/.test(lines[k])) {
          const rest = lines[k].trim().slice(1).trim();
          if (!rest) { k++; arr.push(block(base + 2)); continue; }
          if (/^[\w.@/-]+:( |$)/.test(rest)) {
            // 「- key: v」で始まる対応表
            lines[k] = ' '.repeat(base + 2) + rest;
            arr.push(block(base + 2));
            continue;
          }
          arr.push(val(rest)); k++;
        }
        return arr;
      }
      const obj = {};
      const base = ind(lines[k]);
      while (k < lines.length && ind(lines[k]) === base && !/^ *- /.test(lines[k])) {
        const m = lines[k].trim().match(/^("[^"]*"|'[^']*'|[^:]+):(?: (.*))?$/);
        if (!m) throw new Error(`mapping values are not allowed here (line ${k + 1})`);
        const key = val(m[1]);
        k++;
        if (m[2] !== undefined && m[2] !== '') obj[key] = val(m[2]);
        else if (k < lines.length && (ind(lines[k]) > base || (ind(lines[k]) === base && /^ *- /.test(lines[k])))) obj[key] = block(ind(lines[k]));
        else obj[key] = null;
      }
      return obj;
    }
    return block(0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
