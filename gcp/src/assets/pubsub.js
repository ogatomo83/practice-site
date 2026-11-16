// Pub/Sub：トピック、サブスクリプション（pull と push）、確認応答（ack）と期限、再配信、デッドレター、フィルタ、Node の SDK。
// 状態：w.svc.pubsub = { topics: { 'proj/名前': {…} }, subs: { 'proj/名前': { topic, ackDeadline, push, dlq, maxAttempts, filter, msgs: [{ id, data, attrs, key, published, attempts, leaseUntil }] } } }
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.pubsub = () => ({ topics: {}, subs: {} });
  const P = (w) => w.svc.pubsub;
  const SVC = 'pubsub.googleapis.com';

  const parseName = (c, s, kind) => {
    const m = String(s).match(new RegExp(`^projects/([^/]+)/${kind}/([^/]+)$`));
    if (m) return { project: m[1], name: m[2] };
    return { project: c.need(), name: s };
  };
  const topicView = (t) => ({ name: `projects/${t.project}/topics/${t.name}`, labels: Object.keys(t.labels || {}).length ? t.labels : undefined, messageRetentionDuration: t.retention || undefined });
  const subView = (s) => ({
    ackDeadlineSeconds: s.ackDeadline, deadLetterPolicy: s.dlq ? { deadLetterTopic: `projects/${s.project}/topics/${s.dlq}`, maxDeliveryAttempts: s.maxAttempts } : undefined,
    expirationPolicy: { ttl: '2678400s' }, filter: s.filter || undefined, messageRetentionDuration: '604800s', name: `projects/${s.project}/subscriptions/${s.name}`,
    pushConfig: s.push ? Object.assign({ pushEndpoint: s.push.endpoint }, s.push.sa ? { oidcToken: { serviceAccountEmail: s.push.sa } } : {}) : {},
    retryPolicy: s.retry ? { maximumBackoff: '600s', minimumBackoff: '10s' } : undefined, state: 'ACTIVE', enableMessageOrdering: s.ordering || undefined,
    topic: P(s.w || { svc: { pubsub: { topics: {} } } }) && s.topicDeleted ? '_deleted-topic_' : `projects/${s.tproject || s.project}/topics/${s.topic}`,
  });
  function getTopic(c, s, perm, o = {}) {
    const n = parseName(c, s, 'topics');
    c.call({ method: 'google.pubsub.v1.Publisher.' + (o.method || 'GetTopic'), perm, res: `projects/${n.project}/topics/${n.name}`, svc: SVC, project: n.project, read: !!o.read, resType: 'pubsub_topic', resLabels: { topic_id: n.name },
      deniedMsg: () => `User not authorized to perform this action.` });
    const t = P(c.w).topics[`${n.project}/${n.name}`];
    if (!t) throw new G.Err(404, 'NOT_FOUND', '', { gcloud: `NOT_FOUND: Resource not found (resource=${n.name}).` });
    return t;
  }
  function getSub(c, s, perm, o = {}) {
    const n = parseName(c, s, 'subscriptions');
    c.call({ method: 'google.pubsub.v1.Subscriber.' + (o.method || 'GetSubscription'), perm, res: `projects/${n.project}/subscriptions/${n.name}`, svc: SVC, project: n.project, read: !!o.read, resType: 'pubsub_subscription', resLabels: { subscription_id: n.name },
      deniedMsg: () => `User not authorized to perform this action.` });
    const x = P(c.w).subs[`${n.project}/${n.name}`];
    if (!x) throw new G.Err(404, 'NOT_FOUND', '', { gcloud: `NOT_FOUND: Resource not found (resource=${n.name}).` });
    return x;
  }
  G.ensureTopic = (w, pid, name) => { const k = `${pid}/${name}`; if (!P(w).topics[k]) P(w).topics[k] = { project: pid, name, labels: {}, created: w.t }; return P(w).topics[k]; };

  // ---------------------------------------------------------------- フィルタ（attributes.k = "v"、hasPrefix、NOT、AND、OR）
  function filterOk(expr, attrs) {
    if (!expr) return true;
    const e = expr.trim();
    const or = splitOp(e, ' OR ');
    if (or.length > 1) return or.some((x) => filterOk(x, attrs));
    const and = splitOp(e, ' AND ');
    if (and.length > 1) return and.every((x) => filterOk(x, attrs));
    let m;
    if (/^NOT\s+/.test(e) || /^-/.test(e)) return !filterOk(e.replace(/^NOT\s+|^-/, ''), attrs);
    if (/^\(.*\)$/.test(e)) return filterOk(e.slice(1, -1), attrs);
    if ((m = e.match(/^attributes\.(\w+)\s*(=|!=)\s*"([^"]*)"$/))) return m[2] === '=' ? attrs[m[1]] === m[3] : attrs[m[1]] !== m[3];
    if ((m = e.match(/^attributes:(\w+)$/))) return attrs[m[1]] !== undefined;
    if ((m = e.match(/^hasPrefix\(attributes\.(\w+),\s*"([^"]*)"\)$/))) return String(attrs[m[1]] || '').startsWith(m[2]);
    return false;
  }
  const splitOp = (s, op) => { const out = []; let depth = 0, cur = '', q = false; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === '"') q = !q; if (!q && ch === '(') depth++; if (!q && ch === ')') depth--; if (!q && !depth && s.startsWith(op, i)) { out.push(cur); cur = ''; i += op.length - 1; continue; } cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const validFilter = (e) => { try { filterOk(e, {}); return /attributes/.test(e); } catch (x) { return false; } };

  // ---------------------------------------------------------------- 送る
  G.publish = (w, t, data, attrs, key) => {
    const id = G.digits('msg' + G.seq(w, 'msg'), 16);
    const msg = { id, data, attrs: attrs || {}, key: key || '', published: w.t };
    for (const s of Object.values(P(w).subs)) {
      if (s.topic !== t.name || (s.tproject || s.project) !== t.project || s.topicDeleted) continue;
      if (!filterOk(s.filter, msg.attrs)) continue;
      s.msgs.push(Object.assign({}, msg, { attempts: 0, leaseUntil: 0, sid: G.seq(w, 'ack') }));
      if (s.push) G.emit(w, { kind: 'pubsub.push', sub: `${s.project}/${s.name}` });
    }
    G.tick(w, 20);
    return id;
  };
  // 期限が切れたら、もう一度配る（push は時間が来たら送り直す）
  G.TICK_HOOKS.push((w, from, to) => {
    for (const s of Object.values(P(w).subs)) {
      if (!s.push) continue;
      if (s.msgs.some((m) => m.leaseUntil && m.leaseUntil <= to)) G.emit(w, { kind: 'pubsub.push', sub: `${s.project}/${s.name}` });
    }
  });
  // デッドレター：配った回数が上限を超えたら、別のトピックへ送る
  function overLimit(w, s, m) {
    if (!s.dlq || m.attempts < s.maxAttempts) return false;
    const t = P(w).topics[`${s.project}/${s.dlq}`];
    if (t) G.publish(w, t, m.data, Object.assign({}, m.attrs, { CloudPubSubDeadLetterSourceDeliveryCount: String(m.attempts), CloudPubSubDeadLetterSourceSubscription: s.name, CloudPubSubDeadLetterSourceSubscriptionProject: s.project, CloudPubSubDeadLetterSourceTopicPublishTime: G.iso(m.published) }), m.key);
    s.msgs.splice(s.msgs.indexOf(m), 1);
    return true;
  }
  const ackId = (s, m) => G.b64enc(`${s.name}:${m.sid}:${m.attempts}`).replace(/=+$/, '') + 'RFAGFixdRkhRNxkIaFEOT14jPzUgKEUQBQ';
  // pull：いま配れるもの（期限が切れたものを含む）を、上限まで
  function pullMsgs(w, s, limit) {
    const out = [];
    for (const m of s.msgs.slice()) {
      if (out.length >= limit) break;
      if (m.leaseUntil > w.t) continue;
      if (overLimit(w, s, m)) continue;
      m.attempts++;
      m.leaseUntil = w.t + s.ackDeadline * 1000;
      out.push(m);
    }
    return out;
  }
  const ackMsg = (s, id) => { const k = s.msgs.findIndex((m) => ackId(s, m) === id); if (k < 0) return false; s.msgs.splice(k, 1); return true; };

  // push の配信（Cloud Run の URL、関数のトリガー）
  G.EVENT_HANDLERS['pubsub.push'] = async (sys, ev) => {
    const w = sys.w;
    const s = P(w).subs[ev.sub];
    if (!s || !s.push) return;
    for (const m of s.msgs.slice()) {
      if (m.leaseUntil > w.t) continue;
      if (overLimit(w, s, m)) continue;
      m.attempts++;
      m.leaseUntil = w.t + Math.min(600, 10 * Math.pow(2, m.attempts - 1)) * 1000;
      let ok = false;
      const body = { message: Object.assign({ data: G.b64enc(m.data), messageId: m.id, message_id: m.id, publishTime: G.iso(m.published, 3), publish_time: G.iso(m.published, 3) }, Object.keys(m.attrs).length ? { attributes: m.attrs } : {}, m.key ? { orderingKey: m.key } : {}), subscription: `projects/${s.project}/subscriptions/${s.name}` };
      if (s.push.fn) {
        const f = w.svc.fn.functions[s.push.fn];
        if (f) ok = await G.deliverEvent(sys, f, { id: m.id, source: `//pubsub.googleapis.com/projects/${s.project}/topics/${s.topic}`, specversion: '1.0', type: 'google.cloud.pubsub.topic.v1.messagePublished', time: G.iso(m.published), data: body });
      } else {
        const req = { method: 'POST', url: s.push.endpoint, headers: { 'content-type': 'application/json', 'user-agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)' }, body: JSON.stringify(body) };
        let u; try { u = new URL(s.push.endpoint); } catch (e) { u = null; }
        if (u) {
          const run = /\.run\.app$/.test(u.hostname) && Object.values(w.svc.run.services).find((x) => u.hostname.endsWith(`${x.name}-${w.projects[x.project].projectNumber}.${x.region}.run.app`));
          const r = run ? await G.invokeService(sys, run, req, u, null, { who: s.push.sa || null, internal: true }) : await G.http(sys, req);
          ok = !r.error && [102, 200, 201, 202, 204].includes(r.status);
        }
      }
      if (ok) s.msgs.splice(s.msgs.indexOf(m), 1);
    }
  };
  // Eventarc：関数のトピックのトリガー
  G.makeTriggerSub = (w, f) => {
    const name = `eventarc-${f.region}-${f.name}-${G.alnum('ev' + f.name, 6)}-sub-${G.digits('evs' + f.name, 3)}`;
    P(w).subs[`${f.project}/${name}`] = { project: f.project, name, topic: f.trigger.topic, ackDeadline: 600, push: { endpoint: `https://${f.service}-${w.projects[f.project].projectNumber}.${f.region}.run.app?__GCP_CloudEventsMode=CUSTOM_PUBSUB_projects%2F${f.project}%2Ftopics%2F${f.trigger.topic}`, fn: `${f.project}/${f.region}/${f.name}`, sa: G.computeSa(w, f.project) }, msgs: [], created: w.t, eventarc: true };
  };
  G.dropTriggerSub = (w, f) => { for (const [k, s] of Object.entries(P(w).subs)) if (s.push && s.push.fn === `${f.project}/${f.region}/${f.name}`) delete P(w).subs[k]; };

  // ---------------------------------------------------------------- gcloud pubsub topics
  G.gc('pubsub topics create', { pos: ['TOPIC …'], flags: { labels: 'v', 'message-retention-duration': 'v', 'message-storage-policy-allowed-regions': 'v' }, run: async (c) => {
    for (const nm of c.p) {
      const n = parseName(c, nm, 'topics');
      c.call({ method: 'google.pubsub.v1.Publisher.CreateTopic', perm: 'pubsub.topics.create', res: 'projects/' + n.project, svc: SVC, project: n.project, billable: true, resType: 'pubsub_topic', resLabels: { topic_id: n.name }, resourceName: `projects/${n.project}/topics/${n.name}` });
      if (!/^[A-Za-z][\w.~+%-]{2,254}$/.test(n.name) || /^goog/.test(n.name)) throw new G.Err(400, 'INVALID_ARGUMENT', '', { gcloud: `Failed to create topic [projects/${n.project}/topics/${n.name}]: Invalid [topics] name: (name=projects/${n.project}/topics/${n.name}).\nERROR: (gcloud.pubsub.topics.create) Failed to create the following: [${n.name}].` });
      const k = `${n.project}/${n.name}`;
      if (P(c.w).topics[k]) throw new G.Err(409, '', '', { gcloud: `Failed to create topic [projects/${n.project}/topics/${n.name}]: Resource already exists in the project (resource=${n.name}).\nERROR: (gcloud.pubsub.topics.create) Failed to create the following: [${n.name}].` });
      P(c.w).topics[k] = { project: n.project, name: n.name, labels: c.a.labels ? Object.fromEntries(c.a.labels.split(',').map((x) => x.split('='))) : {}, retention: c.a['message-retention-duration'], created: c.w.t };
      c.w.policies[`projects/${n.project}/topics/${n.name}`] = c.w.policies[`projects/${n.project}/topics/${n.name}`] || { version: 1, etag: 'BwY' + G.alnum('tp' + k, 9) + '=', bindings: [] };
      c.err(`Created topic [projects/${n.project}/topics/${n.name}].\n`);
    }
  } });
  G.gc('pubsub topics list', { fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.pubsub.v1.Publisher.ListTopics', perm: 'pubsub.topics.list', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    return Object.values(P(c.w).topics).filter((t) => t.project === pid).sort((a, b) => (a.name < b.name ? -1 : 1)).map(topicView);
  } });
  G.gc('pubsub topics describe', { pos: ['TOPIC'], fmt: 'yaml', run: async (c) => topicView(getTopic(c, c.p[0], 'pubsub.topics.get', { read: true })) });
  G.gc('pubsub topics delete', { pos: ['TOPIC …'], run: async (c) => {
    for (const nm of c.p) {
      const t = getTopic(c, nm, 'pubsub.topics.delete', { method: 'DeleteTopic' });
      delete P(c.w).topics[`${t.project}/${t.name}`];
      for (const s of Object.values(P(c.w).subs)) if (s.topic === t.name && (s.tproject || s.project) === t.project) s.topicDeleted = true;
      c.err(`Deleted topic [projects/${t.project}/topics/${t.name}].\n`);
    }
  } });
  G.gc('pubsub topics publish', { pos: ['TOPIC'], flags: { message: 'v', attribute: 'v', 'ordering-key': 'v' }, fmt: 'yaml', run: async (c) => {
    const t = getTopic(c, c.p[0], 'pubsub.topics.publish', { method: 'Publish' });
    if (G.scopeCheck) G.scopeCheck(c, 'pubsub');
    if (c.a.message === undefined && !c.a.attribute) throw E.usage('You must provide either a message or attributes or both.');
    const attrs = {};
    if (c.a.attribute) for (const kv of c.a.attribute.split(',')) { const k = kv.indexOf('='); attrs[kv.slice(0, k)] = kv.slice(k + 1); }
    const id = G.publish(c.w, t, c.a.message || '', attrs, c.a['ordering-key']);
    return { messageIds: [id] };
  } });
  G.gc('pubsub topics list-subscriptions', { pos: ['TOPIC'], fmt: 'yaml', run: async (c) => {
    const t = getTopic(c, c.p[0], 'pubsub.topics.get', { read: true });
    return Object.values(P(c.w).subs).filter((s) => s.topic === t.name && !s.topicDeleted).map((s) => `projects/${s.project}/subscriptions/${s.name}`).sort();
  } });
  G.iamCmds('pubsub topics', { pos: 'TOPIC', res: (c) => {
    const n = parseName(c, c.p[0], 'topics');
    if (!P(c.w).topics[`${n.project}/${n.name}`]) throw new G.Err(404, '', '', { gcloud: `NOT_FOUND: Resource not found (resource=${n.name}).` });
    return { name: `projects/${n.project}/topics/${n.name}`, project: n.project, svc: SVC, getPerm: 'pubsub.topics.getIamPolicy', setPerm: 'pubsub.topics.setIamPolicy', kind: 'topic', label: n.name };
  } });

  // ---------------------------------------------------------------- gcloud pubsub subscriptions
  G.gc('pubsub subscriptions create', { pos: ['SUBSCRIPTION …'], flags: { topic: 'v', 'topic-project': 'v', 'ack-deadline': 'v', 'push-endpoint': 'v', 'push-auth-service-account': 'v', 'dead-letter-topic': 'v', 'max-delivery-attempts': 'v', 'message-filter': 'v', 'enable-message-ordering': 'b', 'min-retry-delay': 'v', 'max-retry-delay': 'v', 'expiration-period': 'v', 'message-retention-duration': 'v', 'enable-exactly-once-delivery': 'b' }, req: ['topic'], run: async (c) => {
    const tp = parseName(c, c.a.topic, 'topics');
    if (c.a['topic-project']) tp.project = c.a['topic-project'];
    for (const nm of c.p) {
      const n = parseName(c, nm, 'subscriptions');
      c.call({ method: 'google.pubsub.v1.Subscriber.CreateSubscription', perm: 'pubsub.subscriptions.create', res: 'projects/' + n.project, svc: SVC, project: n.project, resType: 'pubsub_subscription', resLabels: { subscription_id: n.name } });
      if (!P(c.w).topics[`${tp.project}/${tp.name}`]) throw new G.Err(404, '', '', { gcloud: `Failed to create subscription [projects/${n.project}/subscriptions/${n.name}]: Resource not found (resource=${tp.name}).\nERROR: (gcloud.pubsub.subscriptions.create) Failed to create the following: [${n.name}].` });
      if (!G.check(c.w, c.as(), 'pubsub.topics.attachSubscription', `projects/${tp.project}/topics/${tp.name}`).ok) throw new G.Err(403, '', '', { gcloud: `Failed to create subscription [projects/${n.project}/subscriptions/${n.name}]: User not authorized to perform this action.\nERROR: (gcloud.pubsub.subscriptions.create) Failed to create the following: [${n.name}].` });
      const k = `${n.project}/${n.name}`;
      if (P(c.w).subs[k]) throw new G.Err(409, '', '', { gcloud: `Failed to create subscription [projects/${n.project}/subscriptions/${n.name}]: Resource already exists in the project (resource=${n.name}).\nERROR: (gcloud.pubsub.subscriptions.create) Failed to create the following: [${n.name}].` });
      const ack = Number(c.a['ack-deadline'] || 10);
      if (ack < 10 || ack > 600) throw new G.Err(400, '', '', { gcloud: `Failed to create subscription [projects/${n.project}/subscriptions/${n.name}]: The ack deadline must be between 10 and 600 seconds.\nERROR: (gcloud.pubsub.subscriptions.create) Failed to create the following: [${n.name}].` });
      if (c.a['message-filter'] && !validFilter(c.a['message-filter'])) throw new G.Err(400, '', '', { gcloud: `Failed to create subscription [projects/${n.project}/subscriptions/${n.name}]: Invalid filter expression.\nERROR: (gcloud.pubsub.subscriptions.create) Failed to create the following: [${n.name}].` });
      if (c.a['max-delivery-attempts'] && !c.a['dead-letter-topic']) throw E.usage('argument --dead-letter-topic: Must be specified.');
      let dlq = null, max = 5;
      if (c.a['dead-letter-topic']) {
        dlq = parseName(c, c.a['dead-letter-topic'], 'topics').name;
        max = Number(c.a['max-delivery-attempts'] || 5);
        if (max < 5 || max > 100) throw E.usage('argument --max-delivery-attempts: Value must be greater than or equal to 5 and less than or equal to 100.');
      }
      P(c.w).subs[k] = { project: n.project, name: n.name, topic: tp.name, tproject: tp.project !== n.project ? tp.project : undefined, ackDeadline: ack, push: c.a['push-endpoint'] ? { endpoint: c.a['push-endpoint'], sa: c.a['push-auth-service-account'] } : null, dlq, maxAttempts: dlq ? max : undefined, filter: c.a['message-filter'], ordering: !!c.a['enable-message-ordering'], retry: !!c.a['min-retry-delay'], msgs: [], created: c.w.t };
      c.w.policies[`projects/${n.project}/subscriptions/${n.name}`] = { version: 1, etag: 'BwY' + G.alnum('sb' + k, 9) + '=', bindings: [] };
      c.err(`Created subscription [projects/${n.project}/subscriptions/${n.name}].\n`);
      if (dlq) c.err(`WARNING: To use dead letter topics, the Pub/Sub service account (service-${c.w.projects[n.project].projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com) must have the publisher role (roles/pubsub.publisher) on the dead letter topic and the subscriber role (roles/pubsub.subscriber) on this subscription.\n`.replace(/^WARNING: /, '').replace(/^/, ''));
    }
  } });
  G.gc('pubsub subscriptions list', { fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'google.pubsub.v1.Subscriber.ListSubscriptions', perm: 'pubsub.subscriptions.list', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    return Object.values(P(c.w).subs).filter((s) => s.project === pid).sort((a, b) => (a.name < b.name ? -1 : 1)).map(subView);
  } });
  G.gc('pubsub subscriptions describe', { pos: ['SUBSCRIPTION'], fmt: 'yaml', run: async (c) => subView(getSub(c, c.p[0], 'pubsub.subscriptions.get', { read: true })) });
  G.gc('pubsub subscriptions delete', { pos: ['SUBSCRIPTION …'], run: async (c) => {
    for (const nm of c.p) {
      const s = getSub(c, nm, 'pubsub.subscriptions.delete', { method: 'DeleteSubscription' });
      delete P(c.w).subs[`${s.project}/${s.name}`];
      c.err(`Deleted subscription [projects/${s.project}/subscriptions/${s.name}].\n`);
    }
  } });
  G.gc('pubsub subscriptions update', { pos: ['SUBSCRIPTION'], flags: { 'ack-deadline': 'v', 'push-endpoint': 'v', 'dead-letter-topic': 'v', 'max-delivery-attempts': 'v', 'clear-dead-letter-policy': 'b' }, run: async (c) => {
    const s = getSub(c, c.p[0], 'pubsub.subscriptions.update', { method: 'UpdateSubscription' });
    if (c.a['ack-deadline']) s.ackDeadline = Number(c.a['ack-deadline']);
    if (c.a['push-endpoint'] !== undefined) s.push = c.a['push-endpoint'] ? { endpoint: c.a['push-endpoint'] } : null;
    if (c.a['dead-letter-topic']) { s.dlq = parseName(c, c.a['dead-letter-topic'], 'topics').name; s.maxAttempts = Number(c.a['max-delivery-attempts'] || 5); }
    if (c.a['clear-dead-letter-policy']) { s.dlq = null; s.maxAttempts = undefined; }
    c.err(`Updated subscription [projects/${s.project}/subscriptions/${s.name}].\n`);
  } });
  G.gc('pubsub subscriptions pull', { pos: ['SUBSCRIPTION'], flags: { 'auto-ack': 'b', limit: 'v', 'max-messages': 'v', wait: 'b', 'return-immediately': 'b' }, run: async (c) => {
    const s = getSub(c, c.p[0], 'pubsub.subscriptions.consume', { method: 'Pull' });
    if (G.scopeCheck) G.scopeCheck(c, 'pubsub');
    if (s.push) throw new G.Err(400, 'FAILED_PRECONDITION', 'Pull is not supported on a push subscription.');
    const lim = Number(c.a.limit || c.a['max-messages'] || 1);
    c.a.limit = undefined;
    const msgs = pullMsgs(c.w, s, lim);
    if (!msgs.length) { c.err('Listed 0 items.\n'); return; }
    const rows = msgs.map((m) => ({ DATA: m.data, MESSAGE_ID: m.id, ORDERING_KEY: m.key, ATTRIBUTES: Object.entries(m.attrs).map(([k, v]) => `${k}=${v}`).join('\n'), DELIVERY_ATTEMPT: s.dlq ? String(m.attempts) : '', ACK_ID: ackId(s, m), ACK_STATUS: 'SUCCESS' }));
    if (c.a['auto-ack']) for (const m of msgs) s.msgs.splice(s.msgs.indexOf(m), 1);
    if (c.a.format) { c.out(G.fmt.print(msgs.map((m) => ({ ackId: ackId(s, m), message: { data: G.b64enc(m.data), messageId: m.id, publishTime: G.iso(m.published), attributes: Object.keys(m.attrs).length ? m.attrs : undefined, orderingKey: m.key || undefined }, deliveryAttempt: s.dlq ? m.attempts : undefined })), c.a.format, 'yaml')); c.a.format = 'none'; return; }
    // 属性が複数あるときは、セルの中で改行する
    const cols = ['DATA', 'MESSAGE_ID', 'ORDERING_KEY', 'ATTRIBUTES', 'DELIVERY_ATTEMPT', c.a['auto-ack'] ? 'ACK_STATUS' : 'ACK_ID'];
    c.out(boxTable(rows, cols));
  } });
  function boxTable(rows, cols) {
    const cell = (r, k) => String(r[k] || '').split('\n');
    const wlen = (s) => [...s].reduce((n, ch) => n + (/[　-￿]/.test(ch) ? 2 : 1), 0);
    const wid = cols.map((k) => Math.max(k.length, ...rows.flatMap((r) => cell(r, k).map(wlen))));
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wlen(s)));
    const center = (s, n) => { const l = Math.floor((n - s.length) / 2); return ' '.repeat(l) + s + ' '.repeat(n - s.length - l); };
    const line = (l, m, r) => l + wid.map((n) => '─'.repeat(n + 2)).join(m) + r;
    const out = [line('┌', '┬', '┐'), '│ ' + cols.map((k, j) => center(k, wid[j])).join(' │ ') + ' │', line('├', '┼', '┤')];
    for (const r of rows) {
      const h = Math.max(...cols.map((k) => cell(r, k).length));
      for (let i = 0; i < h; i++) out.push('│ ' + cols.map((k, j) => pad(cell(r, k)[i] || '', wid[j])).join(' │ ') + ' │');
    }
    out.push(line('└', '┴', '┘'));
    return out.join('\n') + '\n';
  }
  G.gc('pubsub subscriptions ack', { pos: ['SUBSCRIPTION'], flags: { 'ack-ids': 'v' }, req: ['ack-ids'], fmt: 'yaml', run: async (c) => {
    const s = getSub(c, c.p[0], 'pubsub.subscriptions.consume', { method: 'Acknowledge' });
    const ids = c.a['ack-ids'].split(',');
    for (const id of ids) ackMsg(s, id);
    return { ackIds: ids, subscriptionId: `projects/${s.project}/subscriptions/${s.name}` };
  } });
  G.gc('pubsub subscriptions modify-message-ack-deadline', { pos: ['SUBSCRIPTION'], flags: { 'ack-ids': 'v', 'ack-deadline': 'v' }, req: ['ack-ids', 'ack-deadline'], fmt: 'yaml', run: async (c) => {
    const s = getSub(c, c.p[0], 'pubsub.subscriptions.consume', { method: 'ModifyAckDeadline' });
    const ids = c.a['ack-ids'].split(',');
    for (const m of s.msgs) if (ids.includes(ackId(s, m))) m.leaseUntil = c.w.t + Number(c.a['ack-deadline']) * 1000;
    return { ackDeadlineSeconds: Number(c.a['ack-deadline']), ackIds: ids, subscriptionId: `projects/${s.project}/subscriptions/${s.name}` };
  } });
  G.gc('pubsub subscriptions seek', { pos: ['SUBSCRIPTION'], flags: { time: 'v' }, fmt: 'yaml', run: async (c) => {
    const s = getSub(c, c.p[0], 'pubsub.subscriptions.consume', { method: 'Seek' });
    throw E.plain('このサイトの Pub/Sub は、seek（確認済みのメッセージを取り戻す）に対応していません。');
  } });
  G.iamCmds('pubsub subscriptions', { pos: 'SUBSCRIPTION', res: (c) => {
    const n = parseName(c, c.p[0], 'subscriptions');
    if (!P(c.w).subs[`${n.project}/${n.name}`]) throw new G.Err(404, '', '', { gcloud: `NOT_FOUND: Resource not found (resource=${n.name}).` });
    return { name: `projects/${n.project}/subscriptions/${n.name}`, project: n.project, svc: SVC, getPerm: 'pubsub.subscriptions.getIamPolicy', setPerm: 'pubsub.subscriptions.setIamPolicy', kind: 'subscription', label: n.name };
  } });

  // ---------------------------------------------------------------- Node の SDK（@google-cloud/pubsub）
  const sdkErr = (code, details) => { const e = new Error(`${code} ${['', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED'][code]}: ${details}`); e.code = code; e.details = details; return e; };
  G.sdkErr = sdkErr;
  G.NODE_MODULES['@google-cloud/pubsub'] = (env) => {
    const w = env.w;
    const can = (perm, res) => { G.KNOWN.add(perm); if (!G.check(w, env.who, perm, res).ok) throw sdkErr(7, 'User not authorized to perform this action.'); };
    class Topic {
      constructor(ps, name) { this.ps = ps; this.name = `projects/${ps.projectId}/topics/${name}`; this._n = name; }
      async publishMessage(o) {
        can('pubsub.topics.publish', this.name);
        const t = P(w).topics[`${this.ps.projectId}/${this._n}`];
        if (!t) throw sdkErr(5, `Topic not found`);
        const data = o.data !== undefined ? (o.data && o.data.__b ? o.data.toString() : String(o.data)) : o.json !== undefined ? JSON.stringify(o.json) : '';
        return G.publish(w, t, data, o.attributes, o.orderingKey);
      }
      async publish(buf, attrs) { return this.publishMessage({ data: buf, attributes: attrs }); }
      subscription(n) { return new Sub(this.ps, n); }
      async exists() { return [!!P(w).topics[`${this.ps.projectId}/${this._n}`]]; }
    }
    class Sub {
      constructor(ps, name) { this.ps = ps; this.name = `projects/${ps.projectId}/subscriptions/${name}`; this._n = name; this.handlers = {}; this.open = false; }
      on(ev, fn) {
        this.handlers[ev] = fn;
        if (ev === 'message' && !this.open) { this.open = true; Promise.resolve().then(() => this._pump()); }
        return this;
      }
      async _pump() {
        for (let round = 0; round < 3 && this.open; round++) {
          const s = P(w).subs[`${this.ps.projectId}/${this._n}`];
          if (!s) { if (this.handlers.error) this.handlers.error(sdkErr(5, 'Subscription does not exist')); return; }
          try { can('pubsub.subscriptions.consume', this.name); } catch (e) { if (this.handlers.error) this.handlers.error(e); return; }
          const msgs = pullMsgs(w, s, 100);
          for (const m of msgs) {
            const msg = { id: m.id, data: G.Buffer.from(m.data), attributes: m.attrs, publishTime: new Date(G.T0 + m.published), deliveryAttempt: s.dlq ? m.attempts : 0, orderingKey: m.key, ack: () => { const k = s.msgs.indexOf(m); if (k >= 0) s.msgs.splice(k, 1); }, nack: () => { m.leaseUntil = 0; } };
            try { const r = this.handlers.message(msg); if (r && r.then) await r; } catch (e) { if (this.handlers.error) this.handlers.error(e); else throw e; }
          }
          await Promise.resolve();
        }
      }
      async close() { this.open = false; }
      removeListener() { return this; }
    }
    class PubSub {
      constructor(o = {}) { this.projectId = o.projectId || env.project; }
      topic(n) { return new Topic(this, n); }
      subscription(n) { return new Sub(this, n); }
      async createTopic(n) { can('pubsub.topics.create', 'projects/' + this.projectId); const k = `${this.projectId}/${n}`; if (P(w).topics[k]) throw sdkErr(6, 'Topic already exists'); G.ensureTopic(w, this.projectId, n); return [new Topic(this, n)]; }
      async getTopics() { can('pubsub.topics.list', 'projects/' + this.projectId); return [Object.values(P(w).topics).filter((t) => t.project === this.projectId).map((t) => new Topic(this, t.name))]; }
    }
    return { PubSub };
  };
})(typeof window !== 'undefined' ? window : globalThis);
