// Cloud SQL for PostgreSQL：インスタンス、データベース、ユーザー、バックアップ、gcloud sql connect（psql）、Node の pg モジュール（Cloud Run から /cloudsql/…）。
// 中身の PostgreSQL は PGlite（WebAssembly）。world には「実行して成功した、書き換える SQL の列」だけを持ち、エンジンはページの中に持って、列を流し直して作る。
// エンジンの入手：GCP.PG()（Promise<PGlite のクラス>）。ブラウザでは CDN から、Node では検査スクリプトが差し込む。
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.sql = () => ({ instances: {} });
  const S = (w) => w.svc.sql;
  const SVC = 'sqladmin.googleapis.com';
  G.PG_VER = '0.5.12';
  if (!G.PG) {
    let p = null;
    G.PG = () => (p ||= import(`https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${G.PG_VER}/dist/index.js`).then((m) => m.PGlite));
  }
  const TIERS = { 'db-f1-micro': [0.2, 0.6, 'shared'], 'db-g1-small': [0.5, 1.7, 'shared'], 'db-custom-1-3840': [1, 3.75], 'db-custom-2-7680': [2, 7.5], 'db-custom-4-15360': [4, 15], 'db-perf-optimized-N-2': [2, 16], 'db-perf-optimized-N-4': [4, 32] };
  const VERSIONS = ['POSTGRES_14', 'POSTGRES_15', 'POSTGRES_16', 'POSTGRES_17', 'POSTGRES_18'];

  // ---------------------------------------------------------------- エンジン（ページの中）
  const CACHE = new WeakMap();
  const raw = {};
  for (let i = 1; i < 8000; i++) raw[i] = (x) => x;
  async function engine(w, ik, db) {
    let m = CACHE.get(w);
    if (!m) { m = new Map(); CACHE.set(w, m); }
    const inst = S(w).instances[ik];
    const log = inst.dbs[db].log;
    const key = ik + '/' + db + '#' + inst.dbs[db].gen;
    let e = m.get(key);
    if (!e) {
      const PGlite = await G.PG();
      const pg = await PGlite.create({ parsers: raw });
      await pg.exec(`set timezone = 'UTC'; set datestyle = 'ISO, YMD';`);
      e = { pg, n: 0 };
      m.set(key, e);
    }
    while (e.n < log.length) { try { await e.pg.exec(log[e.n]); } catch (x) {} e.n++; }
    return e;
  }
  // 1 文を実行する。成功して状態を変える文は、列に足す
  async function execOne(w, ik, db, sql, params) {
    const e = await engine(w, ik, db);
    const r = params ? await e.pg.query(sql, params) : (await e.pg.exec(sql))[0];
    if (!/^\s*(select|show|explain|with\s+[\s\S]*?\bselect\b(?![\s\S]*\b(insert|update|delete)\b)|values|table)\b/i.test(sql)) {
      const inst = S(w).instances[ik];
      const lit = params ? sql.replace(/\$(\d+)/g, (m0, k) => { const v = params[Number(k) - 1]; return v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`; }) : sql;
      inst.dbs[db].log.push(lit);
      e.n++;
    }
    return r || { rows: [], fields: [] };
  }
  G.sqlExec = execOne;

  // ---------------------------------------------------------------- psql の表示
  const NUM = new Set([20, 21, 23, 26, 700, 701, 1700, 790]);
  const wid = (s) => [...String(s)].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
  function psqlTable(r) {
    const cols = r.fields.map((f) => f.name);
    const right = r.fields.map((f) => NUM.has(f.dataTypeID));
    const rows = r.rows.map((row) => (Array.isArray(row) ? row : cols.map((c) => row[c])).map((v) => (v === null || v === undefined ? '' : String(v))));
    const W = cols.map((c, j) => Math.max(wid(c), ...rows.map((x) => wid(x[j]))));
    const padL = (s, n) => ' '.repeat(Math.max(0, n - wid(s))) + s;
    const padR = (s, n) => s + ' '.repeat(Math.max(0, n - wid(s)));
    const center = (s, n) => { const sp = n - wid(s); const l = Math.floor(sp / 2); return ' '.repeat(l) + s + ' '.repeat(sp - l); };
    const line = (cells) => cells.map((s, j) => ' ' + s + ' ').join('|').replace(/\s+$/, '');
    const out = [line(cols.map((c, j) => center(c, W[j]))), W.map((n) => '-'.repeat(n + 2)).join('+')];
    for (const x of rows) out.push(line(x.map((s, j) => (right[j] ? padL(s, W[j]) : padR(s, W[j])))));
    out.push(`(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`, '');
    return out.join('\n') + '\n';
  }
  function cmdTag(sql, r) {
    const s = sql.trim().replace(/^\(+/, '').toUpperCase();
    const n = r && r.affectedRows !== undefined ? r.affectedRows : 0;
    if (/^INSERT/.test(s)) return `INSERT 0 ${n}`;
    if (/^UPDATE/.test(s)) return `UPDATE ${n}`;
    if (/^DELETE/.test(s)) return `DELETE ${n}`;
    if (/^(START TRANSACTION|BEGIN)/.test(s)) return 'BEGIN';
    if (/^(COMMIT|END)/.test(s)) return 'COMMIT';
    if (/^ROLLBACK/.test(s)) return 'ROLLBACK';
    const m = s.match(/^(CREATE|DROP|ALTER)\s+(UNIQUE\s+)?(OR REPLACE\s+)?(TABLE|INDEX|VIEW|SCHEMA|ROLE|USER|SEQUENCE|FUNCTION|EXTENSION|TYPE|DATABASE|MATERIALIZED VIEW|TRIGGER)/);
    if (m) return `${m[1]} ${m[4] === 'USER' ? 'ROLE' : m[4]}`;
    if (/^GRANT/.test(s)) return 'GRANT';
    if (/^REVOKE/.test(s)) return 'REVOKE';
    if (/^TRUNCATE/.test(s)) return 'TRUNCATE TABLE';
    if (/^SET/.test(s)) return 'SET';
    if (/^COPY/.test(s)) return `COPY ${n}`;
    return s.split(/\s+/)[0];
  }
  // SQL を文に分ける（引用符、$$、コメントの中の ; は区切りにしない）。行番号（psql:<stdin>:N の N）も返す
  function splitSql(src) {
    const out = [];
    let cur = '', i = 0, line = 1, q = null, dollar = null;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\n') line++;
      if (dollar) { if (src.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; } cur += ch; i++; continue; }
      if (q) { cur += ch; if (ch === q) q = null; i++; continue; }
      if (ch === '-' && src[i + 1] === '-') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; cur += src.slice(i, end); i = end; continue; }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; i++; continue; }
      const dm = src.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (dm) { dollar = dm[0]; cur += dollar; i += dollar.length; continue; }
      if (ch === ';') { if (cur.trim()) out.push({ sql: cur.trim(), line }); cur = ''; i++; continue; }
      if (ch === '\\' && !cur.trim()) { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out.push({ meta: src.slice(i, end).trim(), line }); i = end; continue; }
      cur += ch; i++;
    }
    if (cur.trim()) out.push({ sql: cur.trim(), line, open: true });
    return out;
  }
  // psql（非対話：標準入力の SQL を順に実行する）
  async function psql(c, ik, db, user, script) {
    const w = c.w;
    const inst = S(w).instances[ik];
    let st = 0;
    for (const s of splitSql(script)) {
      if (s.meta) {
        const [cmd, arg] = s.meta.split(/\s+/);
        if (cmd === '\\q') break;
        if (cmd === '\\c' || cmd === '\\connect') { if (!inst.dbs[arg]) { c.err(`connection to server at "${inst.ip}", port 5432 failed: FATAL:  database "${arg}" does not exist\nPrevious connection kept\n`); st = 2; continue; } db = arg; c.out(`psql (17.6 (Debian 17.6-0+deb12u1), server 18.1)\nSSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off, ALPN: postgresql)\nYou are now connected to database "${db}" as user "${user}".\n`); continue; }
        if (cmd === '\\l') { const rows = Object.keys(inst.dbs).sort().map((d) => [d, 'cloudsqlsuperuser', 'UTF8', 'libc', 'en_US.UTF8', 'en_US.UTF8']); c.out(psqlTable({ fields: ['Name', 'Owner', 'Encoding', 'Locale Provider', 'Collate', 'Ctype'].map((n) => ({ name: n, dataTypeID: 25 })), rows }).replace(/^/, '                                                  List of databases\n')); continue; }
        if (cmd === '\\dt') {
          const r = await execOne(w, ik, db, `select n.nspname as "Schema", c.relname as "Name", 'table' as "Type", pg_get_userbyid(c.relowner) as "Owner" from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname not in ('pg_catalog','information_schema') order by 1, 2`);
          if (!r.rows.length) c.err('Did not find any relations.\n'); else c.out('          List of relations\n' + psqlTable(r).replace(/\| postgres$/gm, `| ${user}`));
          continue;
        }
        if (cmd === '\\du') { c.out(psqlTable({ fields: [{ name: 'Role name', dataTypeID: 25 }, { name: 'Attributes', dataTypeID: 25 }], rows: Object.keys(inst.users).sort().map((u) => [u, u === 'postgres' ? 'Create role, Create DB' : '']) }).replace(/\(\d+ rows?\)\n\n$/, '\n')); continue; }
        if (cmd === '\\conninfo') { c.out(`You are connected to database "${db}" as user "${user}" on host "${inst.ip}" at port "5432".\nSSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off, ALPN: postgresql)\n`); continue; }
        c.err(`invalid command ${cmd}\nTry \\? for help.\n`); continue;
      }
      if (s.open) break;   // ; で終わっていない文は、psql は実行しない
      try {
        const r = await execOne(w, ik, db, s.sql);
        if (r.fields && r.fields.length) c.out(psqlTable(r));
        else c.out(cmdTag(s.sql, r) + '\n');
      } catch (e) {
        let msg = `psql:<stdin>:${s.line}: ERROR:  ${e.message}\n`;
        if (e.position) {
          const pos = Number(e.position) - 1;
          const lines = s.sql.split('\n');
          let k = 0, acc = 0;
          while (k < lines.length - 1 && acc + lines[k].length + 1 <= pos) { acc += lines[k].length + 1; k++; }
          const head = `LINE ${k + 1}: `;
          msg += head + lines[k] + '\n' + ' '.repeat(head.length + wid(lines[k].slice(0, pos - acc))) + '^\n';
        }
        if (e.detail) msg += `DETAIL:  ${e.detail}\n`;
        if (e.hint) msg += `HINT:  ${e.hint}\n`;
        c.err(msg);
      }
    }
    return st;
  }

  // ---------------------------------------------------------------- インスタンス
  const instKey = (pid, name) => `${pid}/${name}`;
  const instView = (w, i) => ({
    backendType: 'SECOND_GEN', connectionName: `${i.project}:${i.region}:${i.name}`, createTime: G.iso(i.created), databaseInstalledVersion: i.version + '_' + (i.version === 'POSTGRES_18' ? '1' : '6'), databaseVersion: i.version,
    gceZone: i.zone, instanceType: 'CLOUD_SQL_INSTANCE', ipAddresses: [].concat(i.ip ? [{ ipAddress: i.ip, type: 'PRIMARY' }] : []).concat(i.privateIp ? [{ ipAddress: i.privateIp, type: 'PRIVATE' }] : []).concat(i.ip ? [{ ipAddress: i.outIp, type: 'OUTGOING' }] : []), kind: 'sql#instance', name: i.name, project: i.project, region: i.region,
    serviceAccountEmailAddress: `p${w.projects[i.project].projectNumber}-${G.alnum('sqlsa' + i.name, 6)}@gcp-sa-cloud-sql.iam.gserviceaccount.com`,
    settings: { activationPolicy: i.activation, availabilityType: i.ha ? 'REGIONAL' : 'ZONAL', backupConfiguration: { backupRetentionSettings: { retainedBackups: 7, retentionUnit: 'COUNT' }, enabled: i.backup, kind: 'sql#backupConfiguration', pointInTimeRecoveryEnabled: false, startTime: i.backupStart || '14:00', transactionLogRetentionDays: 7 }, dataDiskSizeGb: String(i.disk), dataDiskType: 'PD_SSD', deletionProtectionEnabled: i.protect, edition: i.edition, ipConfiguration: { authorizedNetworks: i.nets.map((n) => ({ kind: 'sql#aclEntry', value: n })), ipv4Enabled: !!i.ip, privateNetwork: i.privateIp ? `projects/${i.project}/global/networks/default` : undefined, sslMode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED' }, kind: 'sql#settings', pricingPlan: 'PER_USE', storageAutoResize: true, tier: i.tier },
    state: i.state,
  });
  const LIST_FMT = 'table(name, databaseVersion, gceZone:label=LOCATION, settings.tier, primary:label=PRIMARY_ADDRESS, private:label=PRIVATE_ADDRESS, state:label=STATUS)';
  const row = (w, i) => Object.assign(instView(w, i), { primary: i.ip || '-', private: i.privateIp || '-', state: i.activation === 'NEVER' ? 'STOPPED' : i.state });
  function getInst(c, name, perm) {
    const pid = c.need();
    c.call({ method: 'cloudsql.instances.get', perm, res: 'projects/' + pid, svc: SVC, project: pid, read: /get|list|connect/.test(perm) });
    const i = S(c.w).instances[instKey(pid, name)];
    if (!i) throw new G.Err(404, '', '', { gcloud: `HTTPError 404: The Cloud SQL instance does not exist.` });
    return i;
  }
  G.gc('sql instances create', { pos: ['INSTANCE'], flags: { 'database-version': 'v', tier: 'v', cpu: 'v', memory: 'v', region: 'v', zone: 'v', edition: 'v', 'root-password': 'v', 'storage-size': 'v', 'availability-type': 'v', 'no-assign-ip': 'b', network: 'v', 'authorized-networks': 'v', 'backup-start-time': 'v', 'no-backup': 'b', 'deletion-protection': 'b', async: 'b' }, fmt: LIST_FMT, run: async (c) => {
    const pid = c.need();
    const name = c.p[0];
    c.call({ method: 'cloudsql.instances.create', perm: 'cloudsql.instances.create', res: 'projects/' + pid, svc: SVC, project: pid, billable: true, resType: 'cloudsql_database', resLabels: { database_id: `${pid}:${name}` } });
    if (!/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/.test(name)) throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: instance name (${name}).` });
    if (S(c.w).instances[instKey(pid, name)]) throw new G.Err(409, '', '', { gcloud: `Resource already exists. The instance or operation already exists.` });
    const version = c.a['database-version'] || 'POSTGRES_18';
    if (!VERSIONS.includes(version)) throw new G.Err(400, '', '', { gcloud: /^MYSQL|^SQLSERVER/.test(version) ? `このサイトの Cloud SQL は PostgreSQL（${VERSIONS.join(' / ')}）だけを作れます。本物は ${version} も選べます。` : `HTTPError 400: Invalid request: Invalid value for database_version: ${version}.` });
    const edition = (c.a.edition || (version >= 'POSTGRES_16' ? 'enterprise-plus' : 'enterprise')).toUpperCase().replace('-', '_');
    let tier = c.a.tier;
    if (!tier && c.a.cpu) tier = `db-custom-${c.a.cpu}-${Math.round(parseFloat(c.a.memory || '3.75') * 1024)}`;
    tier = tier || (edition === 'ENTERPRISE_PLUS' ? 'db-perf-optimized-N-2' : 'db-custom-1-3840');
    if (!TIERS[tier]) throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: Invalid Tier (${tier}) for (${edition}) Edition.` });
    if (edition === 'ENTERPRISE_PLUS' && !/perf-optimized/.test(tier)) throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: Invalid Tier (${tier}) for (ENTERPRISE_PLUS) Edition. Use a predefined Tier like db-perf-optimized-N-* instead. Learn more at https://cloud.google.com/sql/docs/postgres/create-instance#machine-types.` });
    const region = c.a.region || (c.a.zone ? c.a.zone.replace(/-[a-z]$/, '') : 'us-central1');
    const zone = c.a.zone || region + '-' + 'bac'[G.hash(name) % 3];
    const h = G.hash('sqlip' + pid + name);
    const i = S(c.w).instances[instKey(pid, name)] = {
      project: pid, name, version, edition, tier, region, zone, created: c.w.t, state: 'RUNNABLE', activation: 'ALWAYS', ha: c.a['availability-type'] === 'regional', disk: Number(c.a['storage-size'] || 10), protect: !!c.a['deletion-protection'],
      ip: c.a['no-assign-ip'] ? null : `34.${84 + (h % 3)}.${(h >>> 8) % 250 + 3}.${(h >>> 16) % 250 + 3}`, outIp: `34.${146 + (h % 3)}.${(h >>> 4) % 250}.${(h >>> 12) % 250}`, privateIp: c.a.network ? `10.${20 + (h % 10)}.0.3` : null,
      nets: c.a['authorized-networks'] ? c.a['authorized-networks'].split(',') : [], backup: !c.a['no-backup'], backupStart: c.a['backup-start-time'],
      users: { postgres: { pw: c.a['root-password'] || null, builtin: true } }, dbs: { postgres: { log: [], gen: 0 } }, backups: [],
    };
    G.tick(c.w, 0);
    G.advance(c.w, 7 * 60000);
    c.err(`Creating Cloud SQL instance for ${version}...done.\nCreated [https://sqladmin.googleapis.com/sql/v1beta4/projects/${pid}/instances/${name}].\n`);
    return [row(c.w, i)];
  } });
  G.gc('sql instances list', { fmt: LIST_FMT, uri: true, run: async (c) => {
    const pid = c.need();
    c.call({ method: 'cloudsql.instances.list', perm: 'cloudsql.instances.list', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    return Object.values(S(c.w).instances).filter((i) => i.project === pid).sort((a, b) => (a.name < b.name ? -1 : 1)).map((i) => row(c.w, i));
  } });
  G.gc('sql instances describe', { pos: ['INSTANCE'], fmt: 'yaml', run: async (c) => instView(c.w, getInst(c, c.p[0], 'cloudsql.instances.get')) });
  G.gc('sql instances patch', { pos: ['INSTANCE'], flags: { 'activation-policy': 'v', tier: 'v', 'authorized-networks': 'v', 'clear-authorized-networks': 'b', 'backup-start-time': 'v', 'no-backup': 'b', 'deletion-protection': 'b', 'no-deletion-protection': 'b', 'availability-type': 'v', 'storage-size': 'v' }, run: async (c) => {
    const i = getInst(c, c.p[0], 'cloudsql.instances.update');
    c.call({ method: 'cloudsql.instances.update', perm: 'cloudsql.instances.update', res: 'projects/' + i.project, svc: SVC, project: i.project, resType: 'cloudsql_database' });
    const changes = [];
    if (c.a['activation-policy']) { i.activation = c.a['activation-policy'].toUpperCase(); changes.push('activation'); }
    if (c.a.tier) { if (!TIERS[c.a.tier]) throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: Invalid Tier (${c.a.tier}) for (${i.edition}) Edition.` }); i.tier = c.a.tier; }
    if (c.a['authorized-networks']) i.nets = c.a['authorized-networks'].split(',');
    if (c.a['clear-authorized-networks']) i.nets = [];
    if (c.a['backup-start-time']) { i.backupStart = c.a['backup-start-time']; i.backup = true; }
    if (c.a['no-backup']) i.backup = false;
    if (c.a['deletion-protection']) i.protect = true;
    if (c.a['no-deletion-protection']) i.protect = false;
    if (c.a['availability-type']) i.ha = c.a['availability-type'] === 'regional';
    if (c.a['storage-size']) { const n = parseInt(c.a['storage-size'], 10); if (n < i.disk) throw new G.Err(400, '', '', { gcloud: 'HTTPError 400: Invalid request: Disk size cannot be decreased.' }); i.disk = n; }
    c.err(`The following message will be used for the patch API method.\n{"name": "${i.name}", "project": "${i.project}", "settings": {...}}\n`);
    G.advance(c.w, c.a.tier || c.a['activation-policy'] ? 90000 : 20000);
    c.err(`Patching Cloud SQL instance...done.\nUpdated [https://sqladmin.googleapis.com/sql/v1beta4/projects/${i.project}/instances/${i.name}].\n`);
  } });
  G.gc('sql instances delete', { pos: ['INSTANCE'], flags: { async: 'b' }, run: async (c) => {
    const i = getInst(c, c.p[0], 'cloudsql.instances.delete');
    c.confirm(`All of the instance data will be lost when the instance is deleted.`);
    if (i.protect) throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: The instance is protected. Please disable the deletion protection and try again. To disable deletion protection, update the instance settings with deletionProtectionEnabled set to false.` });
    delete S(c.w).instances[instKey(i.project, i.name)];
    G.advance(c.w, 60000);
    c.err(`Deleting Cloud SQL instance...done.\nDeleted [https://sqladmin.googleapis.com/sql/v1beta4/projects/${i.project}/instances/${i.name}].\n`);
  } });
  G.ON_UNBILL.sql = (w, p) => { for (const i of Object.values(S(w).instances)) if (i.project === p.projectId) i.state = 'SUSPENDED'; };

  // ---------------------------------------------------------------- データベースとユーザー
  G.gc('sql databases create', { pos: ['DATABASE'], flags: { instance: 'v', i: 'v', charset: 'v', collation: 'v' }, run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.databases.create');
    if (i.dbs[c.p[0]]) throw new G.Err(409, '', '', { gcloud: `HTTPError 400: Invalid request: failed to create database ${c.p[0]}. Detail: pq: database "${c.p[0]}" already exists.` });
    if (i.activation === 'NEVER') throw new G.Err(400, '', '', { gcloud: 'HTTPError 400: Invalid request: Invalid request since instance is not running.' });
    i.dbs[c.p[0]] = { log: [], gen: 0 };
    G.advance(c.w, 3000);
    c.err(`Creating Cloud SQL database...done.\nCreated database [${c.p[0]}].\ninstance: ${i.name}\nname: ${c.p[0]}\nproject: ${i.project}\n`);
  } });
  G.gc('sql databases list', { flags: { instance: 'v', i: 'v' }, fmt: 'table(name, charset, collation)', run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.databases.list');
    return Object.keys(i.dbs).sort((a, b) => (a === 'postgres' ? -1 : b === 'postgres' ? 1 : a < b ? -1 : 1)).map((n) => ({ name: n, charset: 'UTF8', collation: 'en_US.UTF8', instance: i.name }));
  } });
  G.gc('sql databases delete', { pos: ['DATABASE'], flags: { instance: 'v', i: 'v' }, run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.databases.delete');
    if (!i.dbs[c.p[0]]) throw new G.Err(404, '', '', { gcloud: `HTTPError 404: Not Found` });
    c.confirm(`The database will be deleted. Any data stored in the database will be destroyed. You cannot undo this action.`);
    delete i.dbs[c.p[0]];
    c.err(`Deleting Cloud SQL database...done.\nDeleted database [${c.p[0]}].\n`);
  } });
  G.gc('sql users create', { pos: ['USERNAME'], flags: { instance: 'v', i: 'v', password: 'v', type: 'v' }, run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.users.create');
    if (i.users[c.p[0]]) throw new G.Err(409, '', '', { gcloud: `HTTPError 409: Conflict: user ${c.p[0]} already exists.` });
    i.users[c.p[0]] = { pw: c.a.password || null };
    await execOne(c.w, instKey(i.project, i.name), 'postgres', `create role "${c.p[0]}" with login createdb createrole in role postgres`);
    G.advance(c.w, 3000);
    c.err(`Creating Cloud SQL user...done.\nCreated user [${c.p[0]}].\n`);
  } });
  G.gc('sql users list', { flags: { instance: 'v', i: 'v' }, fmt: 'table(name.yesno(no="(anonymous)"), host, type.yesno(no="BUILT_IN"), iamStatus)', run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.users.list');
    return Object.keys(i.users).sort().map((n) => ({ name: n, host: '', type: 'BUILT_IN', iamStatus: '' })).map((u) => Object.assign(u, { name: u.name }));
  } });
  G.gc('sql users set-password', { pos: ['USERNAME'], flags: { instance: 'v', i: 'v', password: 'v', prompt_for_password: 'b' }, req: ['password'], run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.users.update');
    if (!i.users[c.p[0]]) throw new G.Err(404, '', '', { gcloud: `HTTPError 404: Not Found` });
    i.users[c.p[0]].pw = c.a.password;
    c.err(`Updating Cloud SQL user...done.\n`);
  } });

  // ---------------------------------------------------------------- バックアップ
  G.gc('sql backups create', { flags: { instance: 'v', i: 'v', description: 'v', async: 'b' }, run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.backupRuns.create');
    const id = String(G.T0 + c.w.t);
    i.backups.push({ id, at: c.w.t, dbs: G.clone(i.dbs), type: 'ON_DEMAND', desc: c.a.description });
    G.advance(c.w, 60000);
    c.err(`Backing up Cloud SQL instance...done.\n[${id}] backed up.\n`.replace(/\[\d+\] backed up\.\n$/, `Backup [${id}] created.\n`));
  } });
  G.gc('sql backups list', { flags: { instance: 'v', i: 'v' }, fmt: 'table(id, windowStartTime:label=WINDOW_START_TIME, error.error.code.yesno(no="-"):label=ERROR, status, instance)', run: async (c) => {
    const i = getInst(c, c.a.instance || c.a.i, 'cloudsql.backupRuns.list');
    return i.backups.slice().reverse().map((b) => ({ id: b.id, windowStartTime: G.iso(b.at), status: 'SUCCESSFUL', instance: i.name, type: b.type }));
  } });
  G.gc('sql backups restore', { pos: ['ID'], flags: { 'restore-instance': 'v', 'backup-instance': 'v', async: 'b' }, req: ['restore-instance'], run: async (c) => {
    const tgt = getInst(c, c.a['restore-instance'], 'cloudsql.instances.restoreBackup');
    const src = c.a['backup-instance'] ? getInst(c, c.a['backup-instance'], 'cloudsql.backupRuns.get') : tgt;
    const b = src.backups.find((x) => x.id === c.p[0]);
    if (!b) throw new G.Err(404, '', '', { gcloud: `HTTPError 404: The backup run does not exist.` });
    c.confirm(`All current data on the instance will be lost when the backup is restored.`);
    tgt.dbs = G.clone(b.dbs);
    for (const d of Object.values(tgt.dbs)) d.gen = (d.gen || 0) + 1 + G.seq(c.w, 'sqlgen');
    G.advance(c.w, 5 * 60000);
    c.err(`Restoring Cloud SQL instance...done.\nRestored [https://sqladmin.googleapis.com/sql/v1beta4/projects/${tgt.project}/instances/${tgt.name}].\n`);
  } });

  // ---------------------------------------------------------------- gcloud sql connect → psql
  G.gc('sql connect', { pos: ['INSTANCE'], flags: { user: 'v', u: 'v', database: 'v', d: 'v', port: 'v' }, run: async (c) => {
    const i = getInst(c, c.p[0], 'cloudsql.instances.connect');
    const user = c.a.user || c.a.u || 'postgres';
    const db = c.a.database || c.a.d || 'postgres';
    if (i.activation === 'NEVER') throw new G.Err(400, '', '', { gcloud: `HTTPError 400: Invalid request: Invalid request since instance is not running.` });
    if (!i.ip) throw new G.Err(400, '', '', { gcloud: `It seems your client does not have ipv6 connectivity and the database instance does not have an ipv4 address. Please request an ipv4 address for this database instance.` });
    G.KNOWN.add('cloudsql.instances.update');
    if (!G.check(c.w, c.as(), 'cloudsql.instances.update', 'projects/' + i.project).ok) throw new G.Err(403, '', '', { gcloud: `HTTPError 403: The client is not authorized to make this request.` });
    c.err(`Allowlisting your IP for incoming connection for 5 minutes...done.\nConnecting to database with SQL user [${user}].`);
    G.advance(c.w, 15000);
    let input = c.stdin || '';
    let pw = c.sys.sh.vars.PGPASSWORD;
    if (pw === undefined) { c.err('Password: '); const k = input.indexOf('\n'); pw = k < 0 ? input : input.slice(0, k); input = k < 0 ? '' : input.slice(k + 1); }
    c.err('\n');
    const u = i.users[user];
    if (!u || u.pw === null || u.pw !== pw) { c.err(`psql: error: connection to server at "${i.ip}", port 5432 failed: FATAL:  password authentication failed for user "${user}"\n`); c.exit = 2; return; }
    if (!i.dbs[db]) { c.err(`psql: error: connection to server at "${i.ip}", port 5432 failed: FATAL:  database "${db}" does not exist\n`); c.exit = 2; return; }
    c.exit = await psql(c, instKey(i.project, i.name), db, user, input);
  } });
  // psql をそのまま打ったとき（Cloud Shell から直接はつながらない）
  G.CMDS.psql = async (sys, a, io) => {
    const h = (a.find((x) => /^(-h|--host=)/.test(x)) || '').replace(/^--host=/, '');
    const host = h === '-h' ? a[a.indexOf('-h') + 1] : h || 'localhost';
    if (host === 'localhost' || host === '127.0.0.1') { io.err(`psql: error: connection to server at "${host === 'localhost' ? '::1' : host}", port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?\n`); return 2; }
    const i = Object.values(S(sys.w).instances).find((x) => x.ip === host);
    const src = sys.vm ? { ip: G.egress(sys.w, sys.vm) } : { ip: G.CLOUD_SHELL_IP };
    if (!i || !src.ip || !i.nets.some((n) => G.inRange(src.ip, n.includes('/') ? n : n + '/32'))) { G.advance(sys.w, 130000); io.err(`psql: error: connection to server at "${host}", port 5432 failed: Connection timed out\n\tIs the server running on that host and accepting TCP/IP connections?\n`); return 2; }
    const user = (a.find((x) => /^(-U|--username=)/.test(x)) || '').replace(/^--username=/, '');
    const uname = user === '-U' ? a[a.indexOf('-U') + 1] : user || 'postgres';
    const dbn = (() => { const k = a.indexOf('-d'); return k >= 0 ? a[k + 1] : 'postgres'; })();
    const pw = sys.sh.vars.PGPASSWORD;
    const u = i.users[uname];
    if (!u || u.pw !== pw) { io.err(`psql: error: connection to server at "${host}", port 5432 failed: FATAL:  password authentication failed for user "${uname}"\n`); return 2; }
    const c = { w: sys.w, out: io.out, err: io.err };
    const ci = a.indexOf('-c');
    return psql(c, instKey(i.project, i.name), dbn, uname, ci >= 0 ? a[ci + 1].replace(/;?\s*$/, ';') : io.stdin || '');
  };

  // ---------------------------------------------------------------- Node の pg（Cloud Run から Unix ソケット /cloudsql/接続名 で）
  G.NODE_MODULES.pg = (env) => {
    const w = env.w;
    const locate = (o) => {
      const host = o.host || '';
      const m = host.match(/^\/cloudsql\/([^:]+):([^:]+):(.+)$/);
      if (!m) { const e = new Error(`connect ECONNREFUSED ${host || '127.0.0.1'}:5432`); e.code = 'ECONNREFUSED'; throw e; }
      const i = S(w).instances[instKey(m[1], m[3])];
      const allowed = env.inRun && (env.inRun.rev.cloudsql || []).includes(`${m[1]}:${m[2]}:${m[3]}`);
      if (!i || !allowed) { const e = new Error(`connect ENOENT ${host}/.s.PGSQL.5432`); e.code = 'ENOENT'; throw e; }
      if (!G.check(w, env.who, 'cloudsql.instances.connect', 'projects/' + m[1]).ok) { const e = new Error(`connect ENOENT ${host}/.s.PGSQL.5432`); e.code = 'ENOENT'; throw e; }
      const u = i.users[o.user || 'postgres'];
      if (!u || u.pw !== o.password) { const e = new Error(`password authentication failed for user "${o.user || 'postgres'}"`); e.code = '28P01'; throw e; }
      const db = o.database || 'postgres';
      if (!i.dbs[db]) { const e = new Error(`database "${db}" does not exist`); e.code = '3D000'; throw e; }
      return { ik: instKey(m[1], m[3]), db };
    };
    const typed = (r) => {
      // 数の型は JavaScript の数に、ほかは文字列のまま（本物の pg に近く。bigint と numeric は文字列）
      const rows = r.rows.map((row) => { const o = {}; r.fields.forEach((f) => { let v = row[f.name]; if (v !== null && [21, 23, 700, 701].includes(f.dataTypeID)) v = Number(v); if (v !== null && f.dataTypeID === 16) v = v === 't'; o[f.name] = v; }); return o; });
      return { rows, rowCount: r.affectedRows !== undefined && !r.fields.length ? r.affectedRows : rows.length, fields: r.fields };
    };
    class Pool {
      constructor(o = {}) { this.o = o; }
      async query(text, params) { const t = locate(this.o); return typed(await execOne(w, t.ik, t.db, typeof text === 'object' ? text.text : text, params || (typeof text === 'object' ? text.values : undefined))); }
      async connect() { const self = this; locate(this.o); return { query: (t, p) => self.query(t, p), release: () => {} }; }
      async end() {}
      on() { return this; }
    }
    class Client extends Pool { async connect() { locate(this.o); } }
    return { Pool, Client };
  };
})(typeof window !== 'undefined' ? window : globalThis);
