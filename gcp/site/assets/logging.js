// Cloud Logging（ログを読む・書く、シンク、ログベースの指標）、Cloud Monitoring（アラートポリシー、通知チャネル、稼働時間チェック）、
// Cloud Identity のグループ（gcloud identity groups）。
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.logging = () => ({ sinks: {}, metrics: {}, policies: {}, channels: {}, uptime: {} });
  const L = (w) => w.svc.logging;
  const SEV = { DEFAULT: 0, DEBUG: 100, INFO: 200, NOTICE: 300, WARNING: 400, ERROR: 500, CRITICAL: 600, ALERT: 700, EMERGENCY: 800 };
  G.SEV = SEV;

  // ---------------------------------------------------------------- フィルタ（Logging のクエリ言語の主な部分）
  function logFilter(entries, expr) {
    if (!expr) return entries;
    // severity>=ERROR → _sev>=500。logName の %2F はそのまま比べる
    let e = expr.replace(/\bseverity\s*(>=|<=|=|>|<|!=)\s*"?([A-Z]+)"?/g, (m, op, s) => `_sev${op}${SEV[s] !== undefined ? SEV[s] : 0}`);
    e = e.replace(/\btimestamp\s*(>=|<=|>|<)\s*"([^"]+)"/g, (m, op, v) => `_ts${op}${Date.parse(v) || 0}`);
    const rows = entries.map((x) => Object.assign({}, x, { _sev: SEV[x.severity] || 0, _ts: Date.parse(x.timestamp) }));
    return G.fmt.filter(rows, e, { substr: true }).map((x) => { const o = Object.assign({}, x); delete o._sev; delete o._ts; return o; });
  }
  G.logFilter = logFilter;
  const viewEntry = (e) => {
    const o = Object.assign({}, e);
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  };

  G.gc('logging read', { pos: ['[LOG_FILTER]'], flags: { limit: 'v', freshness: 'v', order: 'v', 'resource-names': 'v', view: 'v', 'bucket': 'v', location: 'v' }, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.logging.v2.LoggingServiceV2.ListLogEntries', perm: 'logging.logEntries.list', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid, read: true });
    const fresh = c.a.freshness || '1d';
    const m = fresh.match(/^(\d+)([smhdw])$/);
    const ms = m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]] : 864e5;
    // データアクセスの監査ログは、Private Logs Viewer がないと読めない
    const canPrivate = G.check(c.w, c.as(), 'logging.privateLogEntries.list', 'projects/' + pid).ok;
    G.KNOWN.add('logging.privateLogEntries.list');
    let list = c.w.logs.filter((e) => e.logName.startsWith(`projects/${pid}/`) && (canPrivate || !/data_access/.test(e.logName)) && Date.parse(e.timestamp) >= G.T0 + c.w.t - ms);
    list = logFilter(list, c.p[0] ? filterWithLogId(c.p[0]) : c.p[0]);
    const idx = new Map(c.w.logs.map((e, k) => [e, k]));
    list.sort((a, b) => (c.a.order === 'asc' ? 1 : -1) * (Date.parse(a.timestamp) - Date.parse(b.timestamp) || idx.get(a) - idx.get(b)));
    // --limit は --format の後ろの処理より前に効かせる
    const lim = c.a.limit !== undefined ? Number(c.a.limit) : undefined;
    c.a.limit = undefined;
    return (lim !== undefined ? list.slice(0, lim) : list).map(viewEntry);
  }, empty: false });
  G.gc('logging write', { pos: ['LOG_NAME', 'MESSAGE'], flags: { severity: 'v', 'payload-type': 'v', 'monitored-resource-type': 'v', 'monitored-resource-labels': 'v' }, run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.logging.v2.LoggingServiceV2.WriteLogEntries', perm: 'logging.logEntries.create', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid, audit: false });
    const sev = (c.a.severity || 'DEFAULT').toUpperCase();
    if (SEV[sev] === undefined) throw E.usage(`argument --severity: Invalid choice: '${c.a.severity}'.`);
    const e = { logName: `projects/${pid}/logs/${encodeURIComponent(c.p[0]).replace(/%2F/g, '%2F')}`, resource: { type: c.a['monitored-resource-type'] || 'global', labels: { project_id: pid } }, severity: sev };
    if (c.a['payload-type'] === 'json') { try { e.jsonPayload = JSON.parse(c.p[1]); } catch (x) { throw E.plain(`Invalid JSON value: ${c.p[1]}`); } }
    else e.textPayload = c.p[1];
    G.log(c.w, e);
    c.err('Created log entry.\n');
  } });
  G.gc('logging logs list', { fmt: 'table(name:label=NAME)', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListLogs', perm: 'logging.logs.list', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid, read: true });
    const priv = G.check(c.w, c.as(), 'logging.privateLogEntries.list', 'projects/' + pid).ok;
    return [...new Set(c.w.logs.filter((e) => e.logName.startsWith(`projects/${pid}/`) && (priv || !/data_access/.test(e.logName))).map((e) => e.logName))].sort().map((n) => ({ name: n }));
  } });

  // ---------------------------------------------------------------- シンク（ログを BigQuery / Cloud Storage / Pub/Sub へ送る）
  G.gc('logging sinks create', { pos: ['SINK_NAME', 'DESTINATION'], flags: { 'log-filter': 'v', 'use-partitioned-tables': 'b', description: 'v' }, run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.logging.v2.ConfigServiceV2.CreateSink', perm: 'logging.sinks.create', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid });
    const k = `${pid}/${c.p[0]}`;
    if (L(c.w).sinks[k]) throw new G.Err(409, 'ALREADY_EXISTS', `Sink ${c.p[0]} already exists`);
    const d = c.p[1];
    if (!/^(bigquery\.googleapis\.com\/projects\/[^/]+\/datasets\/\w+|storage\.googleapis\.com\/[\w.-]+|pubsub\.googleapis\.com\/projects\/[^/]+\/topics\/[\w.-]+|logging\.googleapis\.com\/.+)$/.test(d)) throw new G.Err(400, 'INVALID_ARGUMENT', `Invalid sink destination: ${d}`);
    const num = c.w.projects[pid].projectNumber;
    const writer = `service-${num}@gcp-sa-logging.iam.gserviceaccount.com`;
    L(c.w).sinks[k] = { project: pid, name: c.p[0], dest: d, filter: c.a['log-filter'] || '', writer, created: c.w.t };
    const role = d.startsWith('bigquery') ? 'BigQuery Data Editor role on the dataset' : d.startsWith('storage') ? 'Storage Object Creator role on the bucket' : 'Pub/Sub Publisher role on the topic';
    c.err(`Created [https://logging.googleapis.com/v2/projects/${pid}/sinks/${c.p[0]}].\nPlease remember to grant \`serviceAccount:${writer}\` the ${role}.\nMore information about sinks can be found at https://cloud.google.com/logging/docs/export/configure_export\n`);
  } });
  G.gc('logging sinks list', { fmt: 'table(name, destination, filter)', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListSinks', perm: 'logging.sinks.list', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid, read: true });
    const own = Object.values(L(c.w).sinks).filter((s) => s.project === pid).map((s) => ({ name: s.name, destination: s.dest, filter: s.filter }));
    // 本物のプロジェクトには、最初から _Required と _Default のシンクがある
    return [{ name: '_Default', destination: `logging.googleapis.com/projects/${pid}/locations/global/buckets/_Default`, filter: 'NOT LOG_ID("cloudaudit.googleapis.com/activity") AND NOT LOG_ID("externalaudit.googleapis.com/activity") AND NOT LOG_ID("cloudaudit.googleapis.com/system_event") AND NOT LOG_ID("externalaudit.googleapis.com/system_event") AND NOT LOG_ID("cloudaudit.googleapis.com/access_transparency") AND NOT LOG_ID("externalaudit.googleapis.com/access_transparency")' }, { name: '_Required', destination: `logging.googleapis.com/projects/${pid}/locations/global/buckets/_Required`, filter: 'LOG_ID("cloudaudit.googleapis.com/activity") OR LOG_ID("externalaudit.googleapis.com/activity") OR LOG_ID("cloudaudit.googleapis.com/system_event") OR LOG_ID("externalaudit.googleapis.com/system_event") OR LOG_ID("cloudaudit.googleapis.com/access_transparency") OR LOG_ID("externalaudit.googleapis.com/access_transparency")' }].concat(own);
  } });
  G.gc('logging sinks describe', { pos: ['SINK_NAME'], fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    const s = L(c.w).sinks[`${pid}/${c.p[0]}`];
    if (!s) throw new G.Err(404, 'NOT_FOUND', `Sink ${c.p[0]} does not exist`);
    return { createTime: G.iso(s.created, 9), destination: s.dest, filter: s.filter || undefined, name: s.name, writerIdentity: 'serviceAccount:' + s.writer };
  } });
  G.gc('logging sinks delete', { pos: ['SINK_NAME'], run: async (c) => {
    const pid = c.need();
    if (!L(c.w).sinks[`${pid}/${c.p[0]}`]) throw new G.Err(404, 'NOT_FOUND', `Sink ${c.p[0]} does not exist`);
    c.confirm(`Really delete sink [${c.p[0]}]?`);
    delete L(c.w).sinks[`${pid}/${c.p[0]}`];
    c.err(`Deleted [${c.p[0]}].\n`);
  } });
  // ログを書いたら、シンクに当たるか調べて送る。LOG_ID("x") は logName の末尾
  const prevLog = G.log;
  G.log = (w, e) => {
    const entry = prevLog(w, e);
    try { route(w, entry); } catch (x) {}
    try { countMetrics(w, entry); } catch (x) {}
    return entry;
  };
  function filterWithLogId(f) { return f.replace(/LOG_ID\("([^"]+)"\)/g, (m, id) => `logName:"${encodeURIComponent(id).replace(/%2F/gi, '%2F')}"`); }
  function route(w, entry) {
    const pid = entry.logName.split('/')[1];
    for (const s of Object.values(L(w).sinks)) {
      if (s.project !== pid) continue;
      if (s.filter && !logFilter([entry], filterWithLogId(s.filter)).length) continue;
      const logId = decodeURIComponent(entry.logName.split('/logs/')[1]).replace(/[^\w]/g, '_');
      if (s.dest.startsWith('bigquery.googleapis.com/')) {
        const m = s.dest.match(/projects\/([^/]+)\/datasets\/(\w+)/);
        const D = w.svc.bq.ds[`${m[1]}:${m[2]}`];
        if (!D || !G.check(w, 'serviceAccount:' + s.writer, 'bigquery.tables.updateData', `projects/${m[1]}/datasets/${m[2]}`).ok && !G.check(w, s.writer, 'bigquery.tables.updateData', `projects/${m[1]}/datasets/${m[2]}`).ok) continue;
        const name = logId;
        const St = (n, t) => ({ name: n, type: t, mode: 'NULLABLE' });
        const t = D.tables[name] = D.tables[name] || { type: 'TABLE', schema: [St('timestamp', 'TIMESTAMP'), St('severity', 'STRING'), St('logName', 'STRING'), St('resource_type', 'STRING'), St('textPayload', 'STRING'), St('jsonPayload', 'STRING'), St('httpRequest_status', 'INTEGER'), St('principalEmail', 'STRING'), St('methodName', 'STRING')], rows: [], created: w.t, modified: w.t, tok: 'sink' + w.t, part: null, cluster: null };
        t.rows.push({ timestamp: entry.timestamp.replace(/(\.\d{3})\d*Z$/, '$1'), severity: entry.severity, logName: entry.logName, resource_type: entry.resource.type, textPayload: entry.textPayload === undefined ? null : entry.textPayload, jsonPayload: entry.jsonPayload ? JSON.stringify(entry.jsonPayload) : null, httpRequest_status: entry.httpRequest ? entry.httpRequest.status : null, principalEmail: entry.protoPayload ? entry.protoPayload.authenticationInfo.principalEmail : null, methodName: entry.protoPayload ? entry.protoPayload.methodName : null });
        t.modified = w.t; t.tok = 'sink' + w.t + '_' + t.rows.length;
      } else if (s.dest.startsWith('storage.googleapis.com/')) {
        const bname = s.dest.split('/')[1];
        const b = G.gcsBucket(w, bname);
        if (!b || !G.check(w, s.writer, 'storage.objects.create', `projects/${b.project}/buckets/${bname}`).ok) continue;
        const d = new Date(Date.parse(entry.timestamp));
        const p2 = (n) => String(n).padStart(2, '0');
        const obj = `${decodeURIComponent(entry.logName.split('/logs/')[1])}/${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCHours())}:00:00_${p2(d.getUTCHours())}:59:59_S0.json`;
        const prev = G.gcsGet(w, bname, obj) || '';
        G.gcsPut(w, bname, obj, prev + JSON.stringify(entry) + '\n', { ctype: 'application/json' });
      } else if (s.dest.startsWith('pubsub.googleapis.com/')) {
        const m = s.dest.match(/projects\/([^/]+)\/topics\/([\w.-]+)/);
        const t = w.svc.pubsub.topics[`${m[1]}/${m[2]}`];
        if (t && G.check(w, s.writer, 'pubsub.topics.publish', `projects/${m[1]}/topics/${m[2]}`).ok) G.publish(w, t, JSON.stringify(entry), { 'logging.googleapis.com/timestamp': entry.timestamp });
      }
    }
  }

  // ---------------------------------------------------------------- ログベースの指標
  G.gc('logging metrics create', { pos: ['METRIC_NAME'], flags: { description: 'v', 'log-filter': 'v', 'config-from-file': 'v' }, run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.logging.v2.MetricsServiceV2.CreateLogMetric', perm: 'logging.logMetrics.create', res: 'projects/' + pid, svc: 'logging.googleapis.com', project: pid });
    if (!c.a['log-filter']) throw E.usage('argument --log-filter: Must be specified.');
    const k = `${pid}/${c.p[0]}`;
    if (L(c.w).metrics[k]) throw new G.Err(409, 'ALREADY_EXISTS', `Metric ${c.p[0]} already exists`);
    L(c.w).metrics[k] = { project: pid, name: c.p[0], desc: c.a.description || '', filter: c.a['log-filter'], points: [], created: c.w.t };
    c.err(`Created [${c.p[0]}].\n`);
  } });
  G.gc('logging metrics list', { fmt: 'table(name, description, filter)', run: async (c) => {
    const pid = c.need();
    return Object.values(L(c.w).metrics).filter((m) => m.project === pid).map((m) => ({ name: m.name, description: m.desc, filter: m.filter }));
  } });
  G.gc('logging metrics describe', { pos: ['METRIC_NAME'], fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    const m = L(c.w).metrics[`${pid}/${c.p[0]}`];
    if (!m) throw new G.Err(404, 'NOT_FOUND', `Metric ${c.p[0]} does not exist`);
    return { createTime: G.iso(m.created, 9), description: m.desc, filter: m.filter, metricDescriptor: { metricKind: 'DELTA', name: `projects/${pid}/metricDescriptors/logging.googleapis.com/user/${m.name}`, type: `logging.googleapis.com/user/${m.name}`, unit: '1', valueType: 'INT64' }, name: m.name };
  } });
  G.gc('logging metrics delete', { pos: ['METRIC_NAME'], run: async (c) => {
    const pid = c.need();
    if (!L(c.w).metrics[`${pid}/${c.p[0]}`]) throw new G.Err(404, 'NOT_FOUND', `Metric ${c.p[0]} does not exist`);
    c.confirm(`Really delete metric [${c.p[0]}]?`);
    delete L(c.w).metrics[`${pid}/${c.p[0]}`];
    c.err(`Deleted [${c.p[0]}].\n`);
  } });
  // 指標を数えて、アラートの条件を調べる（1 分ごとの数）
  function countMetrics(w, entry) {
    const pid = entry.logName.split('/')[1];
    for (const m of Object.values(L(w).metrics)) {
      if (m.project !== pid) continue;
      if (!logFilter([entry], filterWithLogId(m.filter)).length) continue;
      m.points.push(w.t);
      for (const p of Object.values(L(w).policies)) {
        if (p.project !== pid || !p.enabled) continue;
        for (const cond of p.conditions) {
          if (cond.metric !== `logging.googleapis.com/user/${m.name}`) continue;
          const win = Math.max(60000, cond.duration);
          const n = m.points.filter((t) => t > w.t - win).length;
          if (n > cond.threshold && !(p.incidents || []).some((x) => x.state === 'OPEN')) {
            (p.incidents = p.incidents || []).push({ id: G.alnum('inc' + G.seq(w, 'inc'), 16), opened: w.t, state: 'OPEN', value: n, cond: cond.name });
            for (const ch of p.channels) { const cc = L(w).channels[ch]; if (cc) (cc.sent = cc.sent || []).push({ at: w.t, policy: p.displayName, value: n }); }
          }
        }
      }
    }
  }
  G.logMetricCount = (w, pid, name, sinceMs) => { const m = L(w).metrics[`${pid}/${name}`]; return m ? m.points.filter((t) => t > w.t - sinceMs).length : 0; };

  // ---------------------------------------------------------------- Monitoring（アラートポリシー、通知チャネル、稼働時間チェック）
  G.gc('monitoring channels create', { flags: { 'display-name': 'v', type: 'v', 'channel-labels': 'v', 'channel-content': 'v' }, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.monitoring.v3.NotificationChannelService.CreateNotificationChannel', perm: 'monitoring.notificationChannels.create', res: 'projects/' + pid, svc: 'monitoring.googleapis.com', project: pid });
    const id = G.digits('ch' + G.seq(c.w, 'ch'), 19);
    const labels = {};
    for (const kv of (c.a['channel-labels'] || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); labels[k] = v; }
    const name = `projects/${pid}/notificationChannels/${id}`;
    L(c.w).channels[name] = { project: pid, name, displayName: c.a['display-name'] || '', type: c.a.type || 'email', labels };
    c.err(`Created notification channel [${name}].\n`);
    return { displayName: c.a['display-name'], enabled: true, labels, name, type: c.a.type || 'email' };
  } });
  G.gc('monitoring channels list', { fmt: 'table(name.basename():label=NAME, displayName:label=DISPLAY_NAME, type, labels.email_address:label=EMAIL)', run: async (c) => {
    const pid = c.need();
    return Object.values(L(c.w).channels).filter((x) => x.project === pid).map((x) => ({ name: x.name, displayName: x.displayName, type: x.type, labels: x.labels }));
  } });
  G.gc('monitoring policies create', { flags: { 'policy-from-file': 'v', 'notification-channels': 'v', 'display-name': 'v' }, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.monitoring.v3.AlertPolicyService.CreateAlertPolicy', perm: 'monitoring.alertPolicies.create', res: 'projects/' + pid, svc: 'monitoring.googleapis.com', project: pid });
    const f = c.a['policy-from-file'];
    if (!f) throw E.plain('このサイトでは、アラートポリシーを --policy-from-file=ファイル（JSON か YAML）で作ります。');
    const s = G.fs.read(c.sys, f);
    if (s === null) throw E.plain(`Unable to read file [${f}]: [Errno 2] No such file or directory: '${f}'`);
    let p; try { p = G.parseYamlOrJson(s); } catch (e) { throw E.plain(`Unable to parse file [${f}]: ${e.message}`); }
    const id = G.digits('pol' + G.seq(c.w, 'pol'), 19);
    const name = `projects/${pid}/alertPolicies/${id}`;
    const conds = (p.conditions || []).map((x, k) => {
      const th = x.conditionThreshold || {};
      const mm = String(th.filter || '').match(/metric\.type\s*=\s*"([^"]+)"/);
      return { name: `${name}/conditions/${G.digits('cond' + id + k, 19)}`, displayName: x.displayName, metric: mm ? mm[1] : '', threshold: Number(th.thresholdValue || 0), duration: parseInt(th.duration || '0s', 10) * 1000, raw: x };
    });
    const chans = (c.a['notification-channels'] || '').split(',').filter(Boolean).concat(p.notificationChannels || []);
    L(c.w).policies[name] = { project: pid, name, displayName: p.displayName || c.a['display-name'] || '', conditions: conds, channels: chans, enabled: p.enabled !== false, combiner: p.combiner || 'OR', created: c.w.t, incidents: [] };
    c.err(`Created alert policy [${name}].\n`);
    return { combiner: p.combiner || 'OR', conditions: conds.map((x) => Object.assign({ name: x.name }, x.raw)), displayName: L(c.w).policies[name].displayName, enabled: true, name, notificationChannels: chans.length ? chans : undefined };
  } });
  G.gc('monitoring policies list', { fmt: 'table(name.basename():label=NAME, displayName:label=DISPLAY_NAME, enabled:label=ENABLED, conditions.len():label=CONDITIONS)', run: async (c) => {
    const pid = c.need();
    return Object.values(L(c.w).policies).filter((x) => x.project === pid).map((x) => ({ name: x.name, displayName: x.displayName, enabled: x.enabled, conditions: x.conditions }));
  } });
  G.gc('monitoring uptime create', { pos: ['DISPLAY_NAME'], flags: { 'resource-type': 'v', 'resource-labels': 'v', protocol: 'v', path: 'v', period: 'v', 'matcher-content': 'v' }, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.monitoring.v3.UptimeCheckService.CreateUptimeCheckConfig', perm: 'monitoring.uptimeCheckConfigs.create', res: 'projects/' + pid, svc: 'monitoring.googleapis.com', project: pid });
    const labels = {};
    for (const kv of (c.a['resource-labels'] || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); labels[k] = v; }
    const id = c.p[0].toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + G.alnum('up' + c.p[0], 6);
    const name = `projects/${pid}/uptimeCheckConfigs/${id}`;
    L(c.w).uptime[name] = { project: pid, name, displayName: c.p[0], host: labels.host, path: c.a.path || '/', protocol: (c.a.protocol || 'https').toUpperCase(), period: c.a.period || '1' };
    c.err(`Created uptime check config [${id}].\n`);
    return { displayName: c.p[0], httpCheck: { path: c.a.path || '/', port: (c.a.protocol || 'https') === 'http' ? 80 : 443, requestMethod: 'GET', useSsl: (c.a.protocol || 'https') !== 'http' }, monitoredResource: { labels: Object.assign({ project_id: pid }, labels), type: c.a['resource-type'] || 'uptime-url' }, name, period: `${Number(c.a.period || 1) * 60}s`, timeout: '10s' };
  } });
  G.gc('monitoring uptime list-configs', { fmt: 'table(name.basename():label=NAME, displayName:label=DISPLAY_NAME, host, path, period)', run: async (c) => {
    const pid = c.need();
    return Object.values(L(c.w).uptime).filter((x) => x.project === pid);
  } });

  // ---------------------------------------------------------------- Cloud Identity のグループ
  const groupView = (w, email) => { const g = w.groups[email]; return { createTime: '2024-04-02T00:00:00.000Z', description: g.desc || '', displayName: g.displayName, groupKey: { id: email }, labels: { 'cloudidentity.googleapis.com/groups.discussion_forum': '' }, name: `groups/${G.alnum('grp' + email, 15)}`, parent: `customers/${w.org.directoryCustomerId}`, updateTime: '2024-04-02T00:00:00.000Z' }; };
  const owners = { 'dev-team@tsubame.example': ['you@tsubame.example', 'admin@tsubame.example'], 'analysts@tsubame.example': ['admin@tsubame.example', 'you@tsubame.example'] };
  const getGroup = (c, email) => {
    const g = c.w.groups[email];
    const kind = (c.w.people[c.as()] || {}).kind;
    if (!g || kind !== 'managed') throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Error(4003): Permission denied for resource groups/${email} (or it may not exist).` });
    return g;
  };
  G.gc('identity groups describe', { pos: ['EMAIL'], fmt: 'yaml', run: async (c) => { getGroup(c, c.p[0]); return groupView(c.w, c.p[0]); } });
  G.gc('identity groups search', { flags: { labels: 'v', organization: 'v' }, fmt: 'yaml', run: async (c) => ({ groups: Object.keys(c.w.groups).sort().map((e) => groupView(c.w, e)) }) });
  G.gc('identity groups create', { pos: ['EMAIL'], flags: { organization: 'v', 'display-name': 'v', description: 'v', 'with-initial-owner': 'v' }, run: async (c) => {
    const who = c.as();
    if (!(c.w.people[who] || {}).kind || c.w.people[who].kind !== 'managed') throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Error(2015): Permission denied.` });
    if (!c.p[0].endsWith('@' + G.DOMAIN)) throw new G.Err(400, '', '', { gcloud: `INVALID_ARGUMENT: Error(4002): Invalid group email: the domain must belong to the customer.` });
    if (c.w.groups[c.p[0]]) throw new G.Err(409, '', '', { gcloud: `ALREADY_EXISTS: Error(4001): Entity already exists.` });
    c.w.groups[c.p[0]] = { displayName: c.a['display-name'] || c.p[0].split('@')[0], members: [], desc: c.a.description || '', owners: [who] };
    c.err(`Created group [groups/${G.alnum('grp' + c.p[0], 15)}].\n`);
  } });
  G.gc('identity groups memberships list', { flags: { 'group-email': 'v' }, req: ['group-email'], fmt: 'yaml', run: async (c) => {
    const g = getGroup(c, c.a['group-email']);
    const gid = G.alnum('grp' + c.a['group-email'], 15);
    return g.members.slice().sort().map((m) => ({ name: `groups/${gid}/memberships/${G.digits('mem' + m, 21)}`, preferredMemberKey: { id: m }, roles: [{ name: 'MEMBER' }].concat((g.owners || owners[c.a['group-email']] || []).includes(m) ? [{ name: 'OWNER' }] : []) }));
  } });
  G.gc('identity groups memberships add', { flags: { 'group-email': 'v', 'member-email': 'v', roles: 'v' }, req: ['group-email', 'member-email'], fmt: 'yaml', run: async (c) => {
    const g = getGroup(c, c.a['group-email']);
    if (!(g.owners || owners[c.a['group-email']] || []).includes(c.as())) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Error(2015): Permission denied.` });
    const m = c.a['member-email'];
    if (!c.w.people[m] && !c.w.groups[m] && !G.findSa(c.w, m)) throw new G.Err(404, '', '', { gcloud: `NOT_FOUND: Error(2028): Member ${m} not found.` });
    if (g.members.includes(m)) throw new G.Err(409, '', '', { gcloud: `ALREADY_EXISTS: Error(4003): Member already exists.` });
    g.members.push(m);
    G.tick(c.w, 2000);
    return { done: true, response: { '@type': 'type.googleapis.com/google.apps.cloudidentity.groups.v1.Membership', name: `groups/${G.alnum('grp' + c.a['group-email'], 15)}/memberships/${G.digits('mem' + m, 21)}`, preferredMemberKey: { id: m }, roles: [{ name: 'MEMBER' }] } };
  } });
  G.gc('identity groups memberships delete', { flags: { 'group-email': 'v', 'member-email': 'v' }, req: ['group-email', 'member-email'], run: async (c) => {
    const g = getGroup(c, c.a['group-email']);
    if (!(g.owners || owners[c.a['group-email']] || []).includes(c.as())) throw new G.Err(403, '', '', { gcloud: `PERMISSION_DENIED: Error(2015): Permission denied.` });
    if (!g.members.includes(c.a['member-email'])) throw new G.Err(404, '', '', { gcloud: `NOT_FOUND: Error(2028): Membership not found.` });
    g.members = g.members.filter((x) => x !== c.a['member-email']);
    c.err('Deleted membership.\n');
  } });
})(typeof window !== 'undefined' ? window : globalThis);
