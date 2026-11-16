// Compute Engine と VPC：リージョンとゾーン、VM（中に小さなシェル）、ディスクとスナップショット、ネットワーク・サブネット・ファイアウォール、
// 外部 IP と静的アドレス、Cloud NAT、限定公開の Google アクセス、メタデータサーバ、gcloud compute ssh。
// 状態：w.svc.compute = { nets: { 'proj/name': {…} }, subnets: { 'proj/region/name': {…} }, fws: { 'proj/name': {…} }, vms: { 'proj/zone/name': {…} }, disks, snaps, addrs, routers }
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.compute = () => ({ nets: {}, subnets: {}, fws: {}, vms: {}, disks: {}, snaps: {}, addrs: {}, routers: {}, sshKey: false, ipSeq: 0 });
  const C = (w) => w.svc.compute;
  G.CLOUD_SHELL_IP = '34.146.93.21';
  const API = 'https://www.googleapis.com/compute/v1/projects/';

  // ---------------------------------------------------------------- リージョンとゾーン
  // [リージョン, 場所, default ネットワークのサブネット, ゾーン]
  const REGIONS = [
    ['asia-east1', '台湾', '10.140.0.0/20', 'abc'], ['asia-east2', '香港', '10.170.0.0/20', 'abc'],
    ['asia-northeast1', '東京', '10.146.0.0/20', 'abc'], ['asia-northeast2', '大阪', '10.174.0.0/20', 'abc'], ['asia-northeast3', 'ソウル', '10.178.0.0/20', 'abc'],
    ['asia-south1', 'ムンバイ', '10.160.0.0/20', 'abc'], ['asia-southeast1', 'シンガポール', '10.148.0.0/20', 'abc'],
    ['australia-southeast1', 'シドニー', '10.152.0.0/20', 'abc'],
    ['europe-west1', 'ベルギー', '10.132.0.0/20', 'bcd'], ['europe-west2', 'ロンドン', '10.154.0.0/20', 'abc'], ['europe-west4', 'オランダ', '10.164.0.0/20', 'abc'],
    ['us-central1', 'アイオワ', '10.128.0.0/20', 'abcf'], ['us-east1', 'サウスカロライナ', '10.142.0.0/20', 'bcd'], ['us-east4', 'バージニア北部', '10.150.0.0/20', 'abc'], ['us-west1', 'オレゴン', '10.138.0.0/20', 'abc'],
  ];
  G.REGIONS = REGIONS;
  const regionOf = (zone) => zone.replace(/-[a-z]$/, '');
  const zones = () => REGIONS.flatMap(([r, , , z]) => z.split('').map((x) => `${r}-${x}`));
  const MACHINES = [
    ['e2-micro', 2, 1, '共有コア（2 vCPU が時間の 12.5%）'], ['e2-small', 2, 2, '共有コア（25%）'], ['e2-medium', 2, 4, '共有コア（50%）'],
    ['e2-standard-2', 2, 8], ['e2-standard-4', 4, 16], ['e2-highmem-2', 2, 16], ['e2-highcpu-2', 2, 2],
    ['n1-standard-1', 1, 3.75], ['n2-standard-2', 2, 8], ['n2-standard-4', 4, 16], ['n2d-standard-2', 2, 8], ['c3-standard-4', 4, 16], ['t2d-standard-1', 1, 4],
  ];
  const IMAGES = [
    ['debian-12-bookworm-v20261111', 'debian-cloud', 'debian-12', 10], ['debian-11-bullseye-v20261111', 'debian-cloud', 'debian-11', 10],
    ['ubuntu-2404-noble-amd64-v20261105', 'ubuntu-os-cloud', 'ubuntu-2404-lts-amd64', 10], ['ubuntu-2204-jammy-v20261105', 'ubuntu-os-cloud', 'ubuntu-2204-lts', 10],
    ['rocky-linux-9-v20261029', 'rocky-linux-cloud', 'rocky-linux-9', 20], ['cos-121-18867-199-78', 'cos-cloud', 'cos-121-lts', 10],
    ['windows-server-2025-dc-v20261015', 'windows-cloud', 'windows-2025', 50],
  ];
  // Compute の時刻は太平洋時間で書く（-08:00）
  const ctime = (t) => { const d = new Date(G.T0 + t - 8 * 3600000); return d.toISOString().replace('Z', '-08:00'); };

  // ---------------------------------------------------------------- エラー
  const fetchErr = (msg) => new G.Err(0, 'PLAIN', `Could not fetch resource:\n - ${msg}`);
  const someErr = (msg) => new G.Err(0, 'PLAIN', `Some requests did not succeed:\n - ${msg}`);
  function need(c, perm, res, o = {}) {
    const pid = c.need();
    const p = c.w.projects[pid];
    if (!p || p.lifecycleState !== 'ACTIVE') throw fetchErr(`Failed to find project ${pid}`);
    if (!p.services.includes('compute.googleapis.com')) {
      throw new G.Err(0, 'PLAIN', `${o.list ? 'Some requests did not succeed:' : 'Could not fetch resource:'}\n - Compute Engine API has not been used in project ${p.projectNumber} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${p.projectNumber} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`);
    }
    if (perm) {
      const r = G.check(c.w, c.as(), perm, res || 'projects/' + pid);
      G.KNOWN.add(perm);
      if (!r.ok) throw (o.list ? someErr : fetchErr)(`Required '${perm}' permission for '${o.pretty || 'projects/' + pid}'`);
      scopeCheck(c, 'compute');
    }
    if (o.method) G.audit(c.w, { project: pid, who: c.as(), method: 'v1.compute.' + o.method, perm, res: o.pretty || res, svc: 'compute.googleapis.com', resType: o.resType || 'gce_instance', resLabels: o.resLabels });
    if (c.logHttp && o.url) c.err(`=======================\n==== request start ====\nuri: ${o.url}\nmethod: ${o.verb || 'GET'}\n==== request end ====\n`);
    G.tick(c.w, 200);
    return p;
  }
  // VM の中から gcloud を使うとき：アクセススコープ
  function scopeCheck(c, kind) {
    const vm = c.sys.vm;
    if (!vm) return;
    const sc = vm.scopes || [];
    if (sc.includes('cloud-platform')) return;
    const ok = { 'storage-read': ['devstorage.read_only', 'devstorage.read_write', 'devstorage.full_control'], 'storage-write': ['devstorage.read_write', 'devstorage.full_control'], 'logging': ['logging.write', 'logging.admin'], 'pubsub': ['pubsub'] }[kind] || [];
    if (!sc.some((s) => ok.includes(s))) throw new G.Err(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', { gcloud: kind.startsWith('storage') ? 'HTTPError 403: Provided scope(s) are not authorized' : `PERMISSION_DENIED: Request had insufficient authentication scopes.` });
  }
  G.scopeCheck = scopeCheck;

  // ---------------------------------------------------------------- API を有効にしたとき：default ネットワークと既定のサービスアカウント
  G.ON_ENABLE['compute.googleapis.com'] = (w, p) => {
    const pid = p.projectId;
    const net = `${pid}/default`;
    if (!C(w).nets[net]) {
      C(w).nets[net] = { project: pid, name: 'default', mode: 'auto', routing: 'REGIONAL', created: w.t, mtu: 1460, id: G.digits('net' + net, 19) };
      for (const [r, , range] of REGIONS) C(w).subnets[`${pid}/${r}/default`] = { project: pid, region: r, name: 'default', network: 'default', range, pga: false, created: w.t, id: G.digits('sub' + pid + r, 19), gw: range.replace(/0\/20$/, '1') };
      const fw = (name, o) => { C(w).fws[`${pid}/${name}`] = Object.assign({ project: pid, name, network: 'default', direction: 'INGRESS', priority: 65534, sources: ['0.0.0.0/0'], targets: [], disabled: false, created: w.t, id: G.digits('fw' + pid + name, 19), desc: '' }, o); };
      fw('default-allow-icmp', { allow: [{ IPProtocol: 'icmp' }], desc: 'Allow ICMP from anywhere' });
      fw('default-allow-internal', { allow: [{ IPProtocol: 'tcp', ports: ['0-65535'] }, { IPProtocol: 'udp', ports: ['0-65535'] }, { IPProtocol: 'icmp' }], sources: ['10.128.0.0/9'], desc: 'Allow internal traffic on the default network' });
      fw('default-allow-rdp', { allow: [{ IPProtocol: 'tcp', ports: ['3389'] }], desc: 'Allow RDP from anywhere' });
      fw('default-allow-ssh', { allow: [{ IPProtocol: 'tcp', ports: ['22'] }], desc: 'Allow SSH from anywhere' });
    }
    G.ensureComputeSa(w, p);
    const agent = `service-${p.projectNumber}@compute-system.iam.gserviceaccount.com`;
    const pol = w.policies['projects/' + pid];
    pol.bindings.push({ role: 'roles/compute.serviceAgent', members: ['serviceAccount:' + agent] });
    G.bumpEtag(w, pol);
  };
  // 既定のサービスアカウント（Compute Engine default service account）。Compute Engine、Cloud Run、関数、Cloud Build を有効にするとできる。
  // 組織のポリシーで止めていなければ、プロジェクトの Editor が自動で付く（2024 年 5 月より後に作った組織では、既定で止まっている）
  G.ensureComputeSa = (w, p) => {
    const pid = p.projectId;
    const email = G.computeSa(w, pid);
    if ((p.sas || {})[email]) return;
    G.addSa(w, pid, '', { email, displayName: 'Compute Engine default service account' });
    const auto = G.orgPolicyOf(w, 'projects/' + pid, 'iam.automaticIamGrantsForDefaultServiceAccounts');
    if (!(auto && auto.spec.rules && auto.spec.rules[0].enforce)) {
      const pol = w.policies['projects/' + pid];
      let b = pol.bindings.find((x) => x.role === 'roles/editor' && !x.condition);
      if (!b) { b = { role: 'roles/editor', members: [] }; pol.bindings.push(b); }
      if (!b.members.includes('serviceAccount:' + email)) b.members.push('serviceAccount:' + email);
      G.bumpEtag(w, pol);
    }
  };
  for (const api of ['run.googleapis.com', 'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com']) { const prev = G.ON_ENABLE[api]; G.ON_ENABLE[api] = (w, p) => { if (prev) prev(w, p); G.ensureComputeSa(w, p); }; }
  // 請求先を外すと、VM は止まる
  G.ON_UNBILL.compute = (w, p) => { for (const v of Object.values(C(w).vms)) if (v.project === p.projectId && v.status === 'RUNNING') { v.status = 'TERMINATED'; v.listen = {}; } };

  // ---------------------------------------------------------------- regions / zones / machine-types / images
  G.gc('compute regions list', { fmt: 'table(name, quotas.CPUS:label=CPUS, quotas.DISKS_TOTAL_GB:label=DISKS_GB, quotas.IN_USE_ADDRESSES:label=ADDRESSES, quotas.STATIC_ADDRESSES:label=RESERVED_ADDRESSES, status, deprecated.deleted:label=TURNDOWN_DATE)', run: async (c) => {
    need(c, 'compute.regions.list', null, { list: true });
    const pid = c.project;
    return REGIONS.map(([r]) => {
      const vms = Object.values(C(c.w).vms).filter((v) => v.project === pid && regionOf(v.zone) === r);
      const cpus = vms.filter((v) => v.status === 'RUNNING').reduce((n, v) => n + (MACHINES.find((m) => m[0] === v.type) || [0, 0])[1], 0);
      const disk = Object.values(C(c.w).disks).filter((d) => d.project === pid && regionOf(d.zone) === r).reduce((n, d) => n + d.size, 0);
      const ips = vms.filter((v) => v.natIP && v.status === 'RUNNING').length;
      const st = Object.values(C(c.w).addrs).filter((a) => a.project === pid && a.region === r).length;
      return { name: r, quotas: { CPUS: `${cpus}/24`, DISKS_TOTAL_GB: `${disk}/4096`, IN_USE_ADDRESSES: `${ips}/8`, STATIC_ADDRESSES: `${st}/8` }, status: 'UP', description: r, zones: zones().filter((z) => regionOf(z) === r).map((z) => API + `${pid}/zones/${z}`) };
    });
  } });
  G.gc('compute regions describe', { pos: ['NAME'], fmt: 'yaml', run: async (c) => {
    need(c, 'compute.regions.get');
    const r = REGIONS.find((x) => x[0] === c.p[0]);
    if (!r) throw fetchErr(`The resource 'projects/${c.project}/regions/${c.p[0]}' was not found`);
    return { creationTimestamp: '1969-12-31T16:00:00.000-08:00', description: r[0], id: G.digits('region' + r[0], 4), kind: 'compute#region', name: r[0], selfLink: API + `${c.project}/regions/${r[0]}`, status: 'UP', supportsPzs: false, zones: r[3].split('').map((z) => API + `${c.project}/zones/${r[0]}-${z}`) };
  } });
  G.gc('compute zones list', { fmt: 'table(name, region.basename(), status, maintenanceWindows.next_maintenance():label=NEXT_MAINTENANCE, deprecated.deleted:label=TURNDOWN_DATE)', run: async (c) => {
    need(c, 'compute.zones.list', null, { list: true });
    return zones().map((z) => ({ name: z, region: API + `${c.project}/regions/${regionOf(z)}`, status: 'UP', kind: 'compute#zone' }));
  } });
  G.gc('compute machine-types list', { flags: { zones: 'v' }, fmt: 'table(name, zone, guestCpus:label=CPUS, memoryGb:label=MEMORY_GB, deprecated.state:label=DEPRECATED)', run: async (c) => {
    need(c, 'compute.machineTypes.list', null, { list: true });
    const zs = c.a.zones ? c.a.zones.split(',') : zones();
    return zs.flatMap((z) => MACHINES.map(([n, cpu, mem, note]) => ({ name: n, zone: z, guestCpus: cpu, memoryGb: mem, memoryMb: mem * 1024, isSharedCpu: !!note, description: note ? `${cpu} vCPU (${note.replace(/^共有コア（?/, '').replace(/）$/, '')}), ${mem} GB RAM` : `${cpu} vCPUs, ${mem} GB RAM` })));
  } });
  G.gc('compute machine-types describe', { pos: ['NAME'], fmt: 'yaml', run: async (c) => {
    need(c, 'compute.machineTypes.get');
    const z = c.zone();
    if (!z) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--zone] flag.`);
    const m = MACHINES.find((x) => x[0] === c.p[0]);
    if (!m) throw fetchErr(`The resource 'projects/${c.project}/zones/${z}/machineTypes/${c.p[0]}' was not found`);
    return { creationTimestamp: '1969-12-31T16:00:00.000-08:00', description: m[3] ? `Efficient Instance, ${m[1]} vCPU (${m[3]}), ${m[2]} GB RAM` : `${m[1]} vCPUs ${m[2]} GB RAM`, guestCpus: m[1], id: G.digits('mt' + m[0], 6), isSharedCpu: !!m[3], kind: 'compute#machineType', maximumPersistentDisks: m[3] ? 16 : 128, maximumPersistentDisksSizeGb: m[3] ? '3072' : '263168', memoryMb: Math.round(m[2] * 1024), name: m[0], selfLink: API + `${c.project}/zones/${z}/machineTypes/${m[0]}`, zone: z };
  } });
  G.gc('compute images list', { flags: { 'show-deprecated': 'b' }, fmt: 'table(name, selfLink.segment(-4):label=PROJECT, family, deprecated.state:label=DEPRECATED, status)', run: async (c) => {
    need(c, 'compute.images.list', null, { list: true });
    return IMAGES.map(([n, proj, fam, size]) => ({ name: n, family: fam, selfLink: API + `${proj}/global/images/${n}`, status: 'READY', diskSizeGb: String(size) }));
  } });
  G.gc('compute images describe-from-family', { pos: ['FAMILY'], flags: { 'image-project': 'v' }, fmt: 'yaml', run: async (c) => {
    need(c, 'compute.images.get');
    const im = IMAGES.find((x) => x[2] === c.p[0] && (!c.a['image-project'] || x[1] === c.a['image-project']));
    if (!im) throw fetchErr(`The resource 'projects/${c.a['image-project'] || c.project}/global/images/family/${c.p[0]}' was not found`);
    return { architecture: 'X86_64', diskSizeGb: String(im[3]), family: im[2], name: im[0], selfLink: API + `${im[1]}/global/images/${im[0]}`, status: 'READY', licenses: [API + `${im[1]}/global/licenses/${im[2].split('-')[0]}`] };
  } });

  // ---------------------------------------------------------------- IP
  const ipNum = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
  const inRange = (ip, cidr) => { if (cidr === '0.0.0.0/0') return true; const [base, bits] = cidr.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return ((ipNum(ip) & mask) >>> 0) === ((ipNum(base) & mask) >>> 0); };
  G.inRange = inRange;
  const numIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  function externalIp(w, region) {
    const k = ++C(w).ipSeq;
    const h = G.hash('ext' + region + k);
    const pre = region.startsWith('asia-northeast1') ? [34, 84 + (h % 2) * 0] : region.startsWith('us-') ? [34, 41] : [35, 200];
    return `${pre[0]}.${pre[1] + (h % 3)}.${(h >>> 8) % 250 + 3}.${(h >>> 16) % 250 + 3}`;
  }
  function internalIp(w, sub) {
    const used = new Set(Object.values(C(w).vms).filter((v) => v.project === sub.project && v.subnet === sub.name && regionOf(v.zone) === sub.region).map((v) => v.ip));
    const base = ipNum(sub.range.split('/')[0]);
    for (let k = 2; k < 4000; k++) { const ip = numIp(base + k); if (!used.has(ip)) return ip; }
    throw fetchErr('IP space of the subnetwork is exhausted');
  }

  // ---------------------------------------------------------------- ファイアウォールで通るか
  // src = { ip, net?（同じ VPC の中からなら 'proj/name'）, tags?: [] } → dst は VM
  G.reach = (w, src, vm, proto, port) => {
    if (vm.status !== 'RUNNING') return 'timeout';
    // 内部 IP に来るのは、同じネットワークからだけ
    const rules = Object.values(C(w).fws).filter((f) => f.project === vm.project && f.network === vm.network && !f.disabled && (f.direction || 'INGRESS') === 'INGRESS')
      .filter((f) => !f.targets.length || f.targets.some((t) => (vm.tags || []).includes(t)) || (f.targetSAs || []).includes(vm.sa))
      .filter((f) => f.sources.some((r) => inRange(src.ip, r)) || (f.sourceTags || []).some((t) => (src.tags || []).includes(t)))
      .filter((f) => (f.allow || f.deny).some((a) => a.IPProtocol === 'all' || (a.IPProtocol === proto && (!a.ports || a.ports.some((pp) => { const [lo, hi] = pp.split('-').map(Number); return port >= lo && port <= (hi || lo); })))));
    rules.sort((a, b) => a.priority - b.priority || (a.deny ? -1 : 0) - (b.deny ? -1 : 0));
    const r = rules[0];
    if (!r || r.deny) return { blocked: true, rule: r ? r.name : null };
    return { ok: true, rule: r.name };
  };
  // VM から外（インターネット）へ出られるか：外部 IP か Cloud NAT
  G.egress = (w, vm) => {
    if (vm.natIP) return vm.natIP;
    const nat = Object.values(C(w).routers).find((r) => r.project === vm.project && r.network === vm.network && r.region === regionOf(vm.zone) && r.nat);
    return nat ? nat.nat.ip : null;
  };
  G.findVmByIp = (w, ip) => Object.values(C(w).vms).find((v) => v.natIP === ip || v.ip === ip);

  // ---------------------------------------------------------------- VM
  const vmKey = (pid, zone, name) => `${pid}/${zone}/${name}`;
  const vmUrl = (v) => API + `${v.project}/zones/${v.zone}/instances/${v.name}`;
  function vmView(w, v) {
    return {
      canIpForward: false, cpuPlatform: v.status === 'RUNNING' ? 'Intel Broadwell' : 'Unknown CPU Platform', creationTimestamp: ctime(v.created), deletionProtection: !!v.protect,
      disks: [{ autoDelete: true, boot: true, deviceName: v.name, diskSizeGb: String(v.disk), index: 0, interface: 'SCSI', kind: 'compute#attachedDisk', mode: 'READ_WRITE', source: API + `${v.project}/zones/${v.zone}/disks/${v.name}`, type: 'PERSISTENT' }],
      id: v.id, kind: 'compute#instance', labels: Object.keys(v.labels || {}).length ? v.labels : undefined, machineType: API + `${v.project}/zones/${v.zone}/machineTypes/${v.type}`,
      metadata: { fingerprint: G.b64enc(G.hex('md' + v.name + Object.keys(v.meta).join(), 8)).slice(0, 11) + '=', items: Object.keys(v.meta).length ? Object.keys(v.meta).sort().map((k) => ({ key: k, value: v.meta[k] })) : undefined, kind: 'compute#metadata' },
      name: v.name,
      networkInterfaces: [Object.assign({ fingerprint: 'm8eV1SqSN7k=', kind: 'compute#networkInterface', name: 'nic0', network: API + `${v.project}/global/networks/${v.network}`, networkIP: v.ip, stackType: 'IPV4_ONLY', subnetwork: API + `${v.project}/regions/${regionOf(v.zone)}/subnetworks/${v.subnet}` },
        v.access ? { accessConfigs: [Object.assign({ kind: 'compute#accessConfig', name: 'external-nat', networkTier: 'PREMIUM', type: 'ONE_TO_ONE_NAT' }, v.natIP ? { natIP: v.natIP } : {})] } : {})],
      scheduling: { automaticRestart: !v.spot, onHostMaintenance: v.spot ? 'TERMINATE' : 'MIGRATE', preemptible: !!v.spot, provisioningModel: v.spot ? 'SPOT' : 'STANDARD', instanceTerminationAction: v.spot ? 'STOP' : undefined },
      selfLink: vmUrl(v), serviceAccounts: v.sa ? [{ email: v.sa, scopes: v.scopes.map((s) => 'https://www.googleapis.com/auth/' + s) }] : undefined,
      startRestricted: false, status: v.status, tags: v.tags.length ? { fingerprint: G.b64enc(G.hex('tg' + v.tags, 8)).slice(0, 11) + '=', items: v.tags } : { fingerprint: '42WmSpB8rSM=' }, zone: API + `${v.project}/zones/${v.zone}`,
    };
  }
  const LIST_FMT = 'table(name, zone.basename(), machineType.basename():label=MACHINE_TYPE, scheduling.preemptible.yesno(true, ""):label=PREEMPTIBLE, networkInterfaces[0].networkIP:label=INTERNAL_IP, networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP, status)';
  const SCOPE_ALIAS = {
    default: ['devstorage.read_only', 'logging.write', 'monitoring.write', 'service.management.readonly', 'servicecontrol', 'trace.append'],
    'cloud-platform': ['cloud-platform'], 'storage-ro': ['devstorage.read_only'], 'storage-rw': ['devstorage.read_write'], 'storage-full': ['devstorage.full_control'],
    'logging-write': ['logging.write'], 'monitoring-write': ['monitoring.write'], pubsub: ['pubsub'], 'compute-ro': ['compute.readonly'], 'compute-rw': ['compute'], 'bigquery': ['bigquery'],
  };
  function getVm(c, name, perm, o = {}) {
    const pid = c.need();
    let zone = c.zone();
    if (!zone) {
      const hits = Object.values(C(c.w).vms).filter((v) => v.project === pid && v.name === name);
      if (hits.length === 1 && o.guess) zone = hits[0].zone;
      else throw E.plain(`Underspecified resource [${name}]. Specify the [--zone] flag.`);
    }
    need(c, perm, `projects/${pid}/zones/${zone}/instances/${name}`, { pretty: `projects/${pid}/zones/${zone}/instances/${name}`, method: o.method, url: API + `${pid}/zones/${zone}/instances/${name}?alt=json`, verb: o.verb });
    const v = C(c.w).vms[vmKey(pid, zone, name)];
    if (!v) throw fetchErr(`The resource 'projects/${pid}/zones/${zone}/instances/${name}' was not found`);
    return v;
  }
  G.gc('compute instances create', { pos: ['INSTANCE_NAMES …'], flags: {
    zone: 'v', 'machine-type': 'v', 'image-family': 'v', 'image-project': 'v', image: 'v', tags: 'v', metadata: 'v', 'metadata-from-file': 'v', network: 'v', subnet: 'v', 'no-address': 'b', address: 'v',
    'service-account': 'v', scopes: 'v', 'no-service-account': 'b', 'no-scopes': 'b', 'provisioning-model': 'v', preemptible: 'b', 'boot-disk-size': 'v', 'boot-disk-type': 'v', labels: 'v', 'deletion-protection': 'b', 'shielded-secure-boot': 'b', 'instance-termination-action': 'v', 'network-tier': 'v', 'private-network-ip': 'v',
  }, fmt: LIST_FMT, run: async (c) => {
    const pid = c.need();
    const zone = c.zone();
    if (!zone) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--zone] flag.`);
    if (!zones().includes(zone)) throw fetchErr(`Invalid value for field 'zone': '${zone}'. Unknown zone.`);
    const p = need(c, 'compute.instances.create', `projects/${pid}/zones/${zone}`, { pretty: `projects/${pid}/zones/${zone}/instances/${c.p[0]}`, url: API + `${pid}/zones/${zone}/instances?alt=json`, verb: 'POST' });
    if (!p.billing) throw fetchErr(`Billing account for project '${p.projectNumber}' is not found. Billing must be enabled for activation of service(s) 'compute.googleapis.com' to proceed.`);
    const type = c.a['machine-type'] || 'n1-standard-1';
    if (!MACHINES.find((m) => m[0] === type)) throw fetchErr(`Invalid value for field 'resource.machineType': 'https://compute.googleapis.com/compute/v1/projects/${pid}/zones/${zone}/machineTypes/${type}'. Machine type with name '${type}' does not exist in zone '${zone}'.`);
    let img;
    if (c.a.image || c.a['image-family']) {
      img = IMAGES.find((x) => (c.a.image ? x[0] === c.a.image : x[2] === c.a['image-family']) && (!c.a['image-project'] || x[1] === c.a['image-project']));
      if (!img) throw fetchErr(`The resource 'projects/${c.a['image-project'] || pid}/global/images/${c.a['image-family'] ? 'family/' + c.a['image-family'] : c.a.image}' was not found`);
    } else img = IMAGES[0];
    let netName = c.a.network || 'default';
    if (!c.a.network && c.a.subnet) { const sb = C(c.w).subnets[`${pid}/${regionOf(zone)}/${c.a.subnet}`]; if (sb) netName = sb.network; }
    const net = C(c.w).nets[`${pid}/${netName}`];
    if (!net) throw fetchErr(`The resource 'projects/${pid}/global/networks/${netName}' was not found`);
    const subName = c.a.subnet || (net.mode === 'auto' ? netName : null);
    const sub = subName && C(c.w).subnets[`${pid}/${regionOf(zone)}/${subName}`];
    if (!sub) throw fetchErr(`Invalid value for field 'resource.networkInterfaces[0]': '{  "network": "https://compute.googleapis.com/compute/v1/projects/${pid}/global/networks/${netName}",  "accessConfig": [{    "type": "ONE_TO_ONE_NAT",    "name": "External NAT",    "networkTier": "PREMIUM"  }]}'. Subnetwork should be specified for custom subnetmode network`);
    // 組織のポリシー：外部 IP を持てない
    const extPol = G.orgPolicyOf(c.w, 'projects/' + pid, 'compute.vmExternalIpAccess');
    if (extPol && !c.a['no-address'] && (extPol.spec.rules || []).some((r) => r.denyAll)) throw fetchErr(`Constraint constraints/compute.vmExternalIpAccess violated for project ${pid}. Add instance projects/${pid}/zones/${zone}/instances/${c.p[0]} to the constraint to use external IP with it.`);
    let sa = G.computeSa(c.w, pid), scopes = SCOPE_ALIAS.default;
    if (c.a['service-account']) {
      sa = c.a['service-account'];
      const f = G.findSa(c.w, sa);
      if (!f) throw fetchErr(`The resource '${sa}' of type 'serviceAccount' was not found.`);
      if (!G.check(c.w, c.as(), 'iam.serviceAccounts.actAs', `projects/${f.project}/serviceAccounts/${sa}`).ok) throw fetchErr(`The user does not have access to service account '${sa}'.  User: '${c.as()}'.  Ask a project owner to grant you the iam.serviceAccountUser role on the service account`);
    }
    if (c.a.scopes) scopes = c.a.scopes.split(',').flatMap((s) => SCOPE_ALIAS[s] || [s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')]);
    if (c.a['no-service-account']) { sa = ''; scopes = []; }
    const meta = {};
    if (c.a.metadata) for (const kv of G.fmtSplit(c.a.metadata)) { const k = kv.indexOf('='); meta[kv.slice(0, k)] = kv.slice(k + 1); }
    if (c.a['metadata-from-file']) for (const kv of c.a['metadata-from-file'].split(',')) { const [k, f] = kv.split('='); const s = G.fs.read(c.sys, f); if (s === null) throw E.plain(`Unable to read file [${f}]: [Errno 2] No such file or directory: '${f}'`); meta[k] = s; }
    const created = [];
    for (const name of c.p) {
      if (!/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) throw fetchErr(`Invalid value for field 'resource.name': '${name}'. Must be a match of regex '(?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)'`);
      const key = vmKey(pid, zone, name);
      if (C(c.w).vms[key]) throw fetchErr(`The resource 'projects/${pid}/zones/${zone}/instances/${name}' already exists`);
      let natIP = null;
      if (!c.a['no-address']) {
        if (c.a.address) {
          const a = Object.values(C(c.w).addrs).find((x) => x.project === pid && (x.name === c.a.address || x.ip === c.a.address));
          if (!a) throw fetchErr(`The resource 'projects/${pid}/regions/${regionOf(zone)}/addresses/${c.a.address}' was not found`);
          if (a.user) throw fetchErr(`External IP address: ${a.ip} is already in-use.`);
          natIP = a.ip; a.user = key;
        } else natIP = externalIp(c.w, regionOf(zone));
      }
      const v = {
        project: pid, zone, name, type, image: img[0], imageFamily: img[2], disk: Number(String(c.a['boot-disk-size'] || img[3]).replace(/GB$/i, '')), network: netName, subnet: sub.name,
        ip: c.a['private-network-ip'] || internalIp(c.w, sub), natIP, access: !c.a['no-address'], tags: c.a.tags ? c.a.tags.split(',') : [], meta, sa, scopes,
        spot: c.a['provisioning-model'] === 'SPOT' || !!c.a.preemptible, labels: c.a.labels ? Object.fromEntries(c.a.labels.split(',').map((x) => x.split('='))) : {},
        status: 'RUNNING', created: c.w.t, id: G.digits('vm' + key + G.seq(c.w, 'vm'), 19), protect: !!c.a['deletion-protection'], listen: {}, serial: [], sh: null, booted: 0,
      };
      C(c.w).vms[key] = v;
      C(c.w).disks[key] = { project: pid, zone, name, size: v.disk, type: c.a['boot-disk-type'] || 'pd-balanced', user: name, image: img[0], created: c.w.t };
      G.audit(c.w, { project: pid, who: c.as(), method: 'v1.compute.instances.insert', perm: 'compute.instances.create', res: `projects/${pid}/zones/${zone}/instances/${name}`, svc: 'compute.googleapis.com', resType: 'gce_instance', resLabels: { instance_id: v.id, zone } });
      await bootVm(c.sys, v);
      c.err(`Created [${vmUrl(v)}].\n`);
      created.push(vmView(c.w, v));
    }
    G.tick(c.w, 9000);
    return created;
  } });
  G.gc('compute instances list', { flags: { zones: 'v' }, fmt: LIST_FMT, uri: true, run: async (c) => {
    need(c, 'compute.instances.list', null, { list: true });
    return Object.values(C(c.w).vms).filter((v) => v.project === c.project && (!c.a.zones || c.a.zones.split(',').includes(v.zone))).sort((a, b) => (a.zone + a.name < b.zone + b.name ? -1 : 1)).map((v) => Object.assign(vmView(c.w, v), { uri: vmUrl(v) }));
  } });
  G.gc('compute instances describe', { pos: ['NAME'], flags: { zone: 'v' }, fmt: 'yaml', run: async (c) => vmView(c.w, getVm(c, c.p[0], 'compute.instances.get')) });
  const vmOp = (verb, perm, fn, msg) => G.gc('compute instances ' + verb, { pos: ['INSTANCE_NAMES …'], flags: { zone: 'v', 'discard-local-ssd': 'b', async: 'b', 'keep-disks': 'v', 'delete-disks': 'v' }, run: async (c) => {
    const vs = c.p.map((n) => getVm(c, n, perm, { method: 'instances.' + verb, verb: 'POST' }));
    if (verb === 'delete') {
      c.confirm(`The following instances will be deleted. Any attached disks configured to be auto-deleted will be deleted unless they are attached to any other instances or the \`--keep-disks\` flag is given and specifies them for keeping. Deleting a disk is irreversible and any data on the disk will be lost.\n${vs.map((v) => ` - [${v.name}] in [${v.zone}]`).join('\n')}`);
      for (const v of vs) if (v.protect) throw fetchErr(`Invalid resource usage: 'Resource cannot be deleted if it's protected against deletion.'.`);
    }
    if (msg) c.err(`${msg} instance(s) ${vs.map((v) => v.name).join(', ')}...`);
    for (const v of vs) await fn(c, v);
    G.tick(c.w, verb === 'stop' ? 30000 : 15000);
    if (msg) c.err('done.\n');
    for (const v of vs) {
      c.err(`${verb === 'delete' ? 'Deleted' : 'Updated'} [${vmUrl(v)}].\n`);
      if (verb === 'start') c.err(`Instance internal IP is ${v.ip}\n${v.natIP ? `Instance external IP is ${v.natIP}\n` : ''}`);
    }
  } });
  vmOp('stop', 'compute.instances.stop', async (c, v) => { v.status = 'TERMINATED'; v.listen = {}; if (v.natIP && !Object.values(C(c.w).addrs).some((a) => a.ip === v.natIP)) v.natIP = null; v.serial.push(`[  OK  ] Reached target poweroff.target - System Power Off.`); }, 'Stopping');
  vmOp('start', 'compute.instances.start', async (c, v) => { if (v.status === 'RUNNING') return; if (!c.w.projects[v.project].billing) throw fetchErr(`Billing account for project '${c.w.projects[v.project].projectNumber}' is not found. Billing must be enabled for activation of service(s) 'compute.googleapis.com' to proceed.`); v.status = 'RUNNING'; if (v.access && !v.natIP) v.natIP = externalIp(c.w, regionOf(v.zone)); await bootVm(c.sys, v, true); }, 'Starting');
  vmOp('reset', 'compute.instances.reset', async (c, v) => { v.listen = {}; await bootVm(c.sys, v, true); }, null);
  vmOp('delete', 'compute.instances.delete', async (c, v) => {
    const key = vmKey(v.project, v.zone, v.name);
    delete C(c.w).vms[key];
    if (!c.a['keep-disks']) delete C(c.w).disks[key];
    for (const a of Object.values(C(c.w).addrs)) if (a.user === key) a.user = null;
  }, 'Deleting');
  G.gc('compute instances add-tags', { pos: ['INSTANCE_NAME'], flags: { zone: 'v', tags: 'v' }, req: ['tags'], run: async (c) => {
    const v = getVm(c, c.p[0], 'compute.instances.setTags', { method: 'instances.setTags' });
    for (const t of c.a.tags.split(',')) if (!v.tags.includes(t)) v.tags.push(t);
    c.err(`Updated [${vmUrl(v)}].\n`);
  } });
  G.gc('compute instances remove-tags', { pos: ['INSTANCE_NAME'], flags: { zone: 'v', tags: 'v', all: 'b' }, run: async (c) => {
    const v = getVm(c, c.p[0], 'compute.instances.setTags', { method: 'instances.setTags' });
    v.tags = c.a.all ? [] : v.tags.filter((t) => !(c.a.tags || '').split(',').includes(t));
    c.err(`Updated [${vmUrl(v)}].\n`);
  } });
  G.gc('compute instances add-metadata', { pos: ['INSTANCE_NAME'], flags: { zone: 'v', metadata: 'v', 'metadata-from-file': 'v' }, run: async (c) => {
    const v = getVm(c, c.p[0], 'compute.instances.setMetadata', { method: 'instances.setMetadata' });
    if (c.a.metadata) for (const kv of G.fmtSplit(c.a.metadata)) { const k = kv.indexOf('='); v.meta[kv.slice(0, k)] = kv.slice(k + 1); }
    if (c.a['metadata-from-file']) for (const kv of c.a['metadata-from-file'].split(',')) { const [k, f] = kv.split('='); v.meta[k] = G.fs.read(c.sys, f) || ''; }
    c.err(`Updated [${vmUrl(v)}].\n`);
  } });
  G.gc('compute instances set-service-account', { pos: ['INSTANCE_NAME'], flags: { zone: 'v', 'service-account': 'v', scopes: 'v', 'no-scopes': 'b' }, run: async (c) => {
    const v = getVm(c, c.p[0], 'compute.instances.setServiceAccount', { method: 'instances.setServiceAccount' });
    if (v.status === 'RUNNING') throw fetchErr(`The instance must be stopped before the service account can be changed.`);
    if (c.a['service-account']) v.sa = c.a['service-account'];
    if (c.a.scopes) v.scopes = c.a.scopes.split(',').flatMap((s) => SCOPE_ALIAS[s] || [s]);
    c.err(`Updated [${vmUrl(v)}].\n`);
  } });
  G.gc('compute instances get-serial-port-output', { pos: ['NAME'], flags: { zone: 'v', start: 'v', port: 'v' }, run: async (c) => {
    const v = getVm(c, c.p[0], 'compute.instances.getSerialPortOutput', { guess: false });
    c.err(`Specify --start=${v.serial.join('\n').length} in the next get-serial-port-output invocation to get only the new output starting from here.\n`);
    c.out(v.serial.join('\n') + '\n');
  } });

  // ---------------------------------------------------------------- VM の中（起動、スタートアップスクリプト、小さなシェル）
  function vmShell(v) {
    if (!v.sh) {
      const st = G.sh.newState();
      st.files = { '/etc/hostname': v.name + '\n', '/etc/os-release': v.imageFamily.startsWith('ubuntu') ? 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\n' : 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n' };
      st.dirs = ['/etc', '/home', '/home/you', '/tmp', '/var', '/var/log', '/usr', '/usr/bin'];
      st.pkgs = ['curl', 'python3', 'google-guest-agent', 'google-cloud-cli'];
      st.units = {};
      v.sh = st;
    }
    return v.sh;
  }
  G.vmSys = (sys, v) => {
    const s = new G.Sys(sys.w, vmShell(v));
    s.vm = v;
    return s;
  };
  // VM の中でコマンドを実行する（gcloud は VM のサービスアカウントとして）
  G.vmRun = async (sys, v, src, opts = {}) => {
    const s = G.vmSys(sys, v);
    const w = sys.w;
    const saved = { cfg: w.cfg, creds: w.creds };
    w.cfg = { active: 'default', configurations: { default: { core: { account: v.sa || undefined, project: v.project } } } };
    w.creds = v.sa ? [v.sa] : [];
    s.sh.cwd = opts.root ? '/' : '/home/you';
    s.root = !!opts.root;
    try { return await s.run(src, { stdin: opts.stdin || '' }); }
    finally { w.cfg = saved.cfg; w.creds = saved.creds; }
  };
  async function bootVm(sys, v, again) {
    const w = sys.w;
    v.serial.push(`[    0.000000] Linux version 6.1.0-27-cloud-amd64 (debian-kernel@lists.debian.org)`, `[    2.104412] systemd[1]: Hostname set to <${v.name}>.`, `${new Date(G.T0 + w.t).toUTCString().slice(5, 25)} ${v.name} google_guest_agent[512]: GCE Agent Started (version 20261008.00)`);
    vmShell(v);
    v.booted = w.t;
    // パッケージで入ったサービスは、起動のたびに動く
    for (const [u, st] of Object.entries(v.sh.units || {})) if (st.enabled) startUnit(v, u);
    const script = v.meta['startup-script'];
    if (script) {
      v.serial.push(`${v.name} google_metadata_script_runner[601]: Starting startup scripts (version 20261008.00).`, `${v.name} google_metadata_script_runner[601]: Found startup-script in metadata.`);
      const r = await G.vmRun(sys, v, script, { root: true });
      for (const l of (r.stdout + r.stderr).split('\n').filter(Boolean)) v.serial.push(`${v.name} google_metadata_script_runner[601]: startup-script: ${l}`);
      v.serial.push(`${v.name} google_metadata_script_runner[601]: startup-script exit status ${r.exit}`, `${v.name} google_metadata_script_runner[601]: Finished running startup scripts.`);
      G.log(w, { logName: `projects/${v.project}/logs/google_metadata_script_runner`, resource: { type: 'gce_instance', labels: { instance_id: v.id, project_id: v.project, zone: v.zone } }, severity: r.exit ? 'ERROR' : 'INFO', jsonPayload: { message: `startup-script exit status ${r.exit}` } });
    }
    // 起動とスクリプトには時間がかかる：サーバに届くのは、少し後から
    v.readyAt = w.t + 25000;
  }
  function startUnit(v, u) {
    const st = v.sh.units[u];
    st.active = true;
    if (u === 'nginx' || u === 'apache2') v.listen[80] = { kind: u, root: '/var/www/html' };
  }
  const CMDS = G.CMDS;
  const onVm = (sys) => !!sys.vm;
  // apt-get / apt
  const PKGS = { nginx: '1.22.1-9+deb12u2', apache2: '2.4.62-1~deb12u2', git: '1:2.39.5-0+deb12u1', 'postgresql-client': '15+248', 'default-mysql-client': '1.1.0', htop: '3.2.2-2' };
  CMDS['apt-get'] = CMDS.apt = async (sys, a, io, name) => {
    if (!onVm(sys)) { io.err(`${name}: Cloud Shell では、パッケージの追加は ~/.customize_environment に書きます（このサイトの Cloud Shell では使えません）。VM の中（gcloud compute ssh や startup-script）では使えます\n`); return 100; }
    if (!sys.root) { io.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n'); return 100; }
    const v = sys.vm;
    const out = G.egress(sys.w, v);
    const sub = a.filter((x) => !x.startsWith('-'));
    if (sub[0] === 'update') {
      if (!out) { io.out('Ign:1 https://deb.debian.org/debian bookworm InRelease\nIgn:2 https://deb.debian.org/debian-security bookworm-security InRelease\nErr:1 https://deb.debian.org/debian bookworm InRelease\n  Could not connect to deb.debian.org:443 (151.101.2.132), connection timed out\nReading package lists...\n'); io.err('W: Failed to fetch https://deb.debian.org/debian/dists/bookworm/InRelease  Could not connect to deb.debian.org:443 (151.101.2.132), connection timed out\nW: Some index files failed to download. They have been ignored, or old ones used instead.\n'); G.advance(sys.w, 60000); return 0; }
      io.out('Hit:1 https://deb.debian.org/debian bookworm InRelease\nGet:2 https://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]\nGet:3 https://deb.debian.org/debian-security bookworm-security InRelease [48.0 kB]\nFetched 103 kB in 1s (142 kB/s)\nReading package lists...\n');
      return 0;
    }
    if (sub[0] === 'install') {
      const want = sub.slice(1);
      const unknown = want.filter((p) => !PKGS[p] && !v.sh.pkgs.includes(p));
      io.out('Reading package lists...\nBuilding dependency tree...\nReading state information...\n');
      if (unknown.length) { io.err(`E: Unable to locate package ${unknown[0]}\n`); return 100; }
      const fresh = want.filter((p) => !v.sh.pkgs.includes(p));
      if (!fresh.length) { io.out(want.map((p) => `${p} is already the newest version (${PKGS[p] || 'installed'}).`).join('\n') + '\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'); return 0; }
      if (!out) { io.err(`E: Failed to fetch https://deb.debian.org/debian/pool/main/n/${fresh[0]}/${fresh[0]}_${PKGS[fresh[0]]}_amd64.deb  Could not connect to deb.debian.org:443 (151.101.2.132), connection timed out\nE: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?\n`); G.advance(sys.w, 120000); return 100; }
      io.out(`The following NEW packages will be installed:\n  ${fresh.join(' ')}\n0 upgraded, ${fresh.length} newly installed, 0 to remove and 0 not upgraded.\n`);
      for (const p of fresh) {
        io.out(`Setting up ${p} (${PKGS[p]}) ...\n`);
        v.sh.pkgs.push(p);
        if (p === 'nginx' || p === 'apache2') {
          for (const d of ['/var', '/var/www', '/var/www/html', '/etc/' + p]) if (!v.sh.dirs.includes(d)) v.sh.dirs.push(d);
          v.sh.files[p === 'nginx' ? '/var/www/html/index.nginx-debian.html' : '/var/www/html/index.html'] = p === 'nginx'
            ? '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>\n'
            : '<html><body><h1>Apache2 Debian Default Page</h1><p>It works!</p></body></html>\n';
          v.sh.units[p] = { enabled: true };
          startUnit(v, p);
        }
      }
      G.advance(sys.w, 8000 * fresh.length);
      return 0;
    }
    io.err(`E: Invalid operation ${sub[0] || ''}\n`); return 100;
  };
  CMDS.systemctl = async (sys, a, io) => {
    if (!onVm(sys)) { io.err('System has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down\n'); return 1; }
    const v = sys.vm;
    const [verb, unit0] = a.filter((x) => !x.startsWith('-'));
    const unit = (unit0 || '').replace(/\.service$/, '');
    const st = v.sh.units[unit];
    if (!st) { io.err(`Unit ${unit}.service could not be found.\n`); return verb === 'status' ? 4 : 5; }
    if (verb === 'status') { io.out(`● ${unit}.service - A high performance web server and a reverse proxy server\n     Loaded: loaded (/lib/systemd/system/${unit}.service; ${st.enabled ? 'enabled' : 'disabled'}; preset: enabled)\n     Active: ${st.active ? 'active (running)' : 'inactive (dead)'}\n`); return st.active ? 0 : 3; }
    if (!sys.root) { io.err(`Failed to ${verb} ${unit}.service: Access denied\nSee system logs and 'systemctl status ${unit}.service' for details.\n`); return 1; }
    if (verb === 'start' || verb === 'restart' || verb === 'reload') startUnit(v, unit);
    else if (verb === 'stop') { st.active = false; delete v.listen[80]; }
    else if (verb === 'enable') st.enabled = true;
    else if (verb === 'disable') st.enabled = false;
    return 0;
  };
  CMDS.sudo = async (sys, a, io) => {
    if (!a.length) { io.err('usage: sudo -h | -K | -k | -V\n'); return 1; }
    const was = sys.root; sys.root = true;
    try { const f = CMDS[a[0]]; if (!f) { io.err(`sudo: ${a[0]}: command not found\n`); return 1; } return await f(sys, a.slice(1), io, a[0]); }
    finally { sys.root = was; }
  };
  CMDS.hostname = async (sys, a, io) => {
    if (!onVm(sys)) { io.out(`cs-${G.digits('cs', 12)}-default\n`); return 0; }
    if (a[0] === '-I' || a[0] === '-i') { io.out(sys.vm.ip + ' \n'); return 0; }
    io.out(sys.vm.name + '\n'); return 0;
  };
  CMDS.tee = async (sys, a, io) => {
    const app = a.includes('-a');
    for (const f of a.filter((x) => !x.startsWith('-'))) {
      if (onVm(sys) && /^\/(var|etc)\//.test(G.fs.norm(sys, f)) && !sys.root) { io.err(`tee: ${f}: Permission denied\n`); return 1; }
      const prev = app ? G.fs.read(sys, f) || '' : '';
      if (G.fs.write(sys, f, prev + (io.stdin || '')) !== true) { io.err(`tee: ${f}: No such file or directory\n`); return 1; }
    }
    io.out(io.stdin || '');
    return 0;
  };
  CMDS.uname = async (sys, a, io) => { io.out(a.includes('-r') ? '6.1.0-27-cloud-amd64\n' : a.includes('-a') ? `Linux ${onVm(sys) ? sys.vm.name : 'cs-' + G.digits('cs', 12) + '-default'} 6.1.0-27-cloud-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.115-1 (2024-11-01) x86_64 GNU/Linux\n` : 'Linux\n'); return 0; };

  // VM の 80 番などに来た HTTP
  function serveVm(sys, v, req, u) {
    const l = v.listen[Number(u.port || 80)];
    const root = l.root;
    let path = decodeURIComponent(u.pathname);
    if (path.endsWith('/')) path += 'index.html';
    let s = G.fs.read({ sh: v.sh }, root + path);
    if (s === null && u.pathname === '/') s = G.fs.read({ sh: v.sh }, root + '/index.nginx-debian.html');
    const server = l.kind === 'nginx' ? 'nginx/1.22.1' : 'Apache/2.4.62 (Debian)';
    if (s === null) return { status: 404, headers: { server, 'content-type': 'text/html' }, body: `<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.22.1</center>\r\n</body>\r\n</html>\r\n` };
    return { status: 200, headers: { server, 'content-type': /\.html$/.test(path) ? 'text/html' : 'text/plain' }, body: s };
  }
  G.ROUTES.push({
    name: 'vm',
    match: (w, u) => /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && (u.hostname.startsWith('10.') || G.findVmByIp(w, u.hostname)),
    handle: (sys, req, u) => {
      const w = sys.w;
      const ip = u.hostname;
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      const v = G.findVmByIp(w, ip);
      const timeout = () => { const ms = (req.connTimeout || 130) * 1000 + 2; return { error: 28, wait: ms, msg: req.connTimeout ? `Failed to connect to ${ip} port ${port} after ${ms} ms: Timeout was reached` : `Failed to connect to ${ip} port ${port} after ${ms} ms: Couldn't connect to server` }; };
      // 送り元
      let src;
      const me = sys.vm;
      if (ip.startsWith('10.')) {
        if (!me || !v || v.network !== me.network || v.project !== me.project) return timeout();
        src = { ip: me.ip, tags: me.tags };
      } else {
        if (v && v.natIP !== ip) return timeout();
        if (me) { const e = G.egress(w, me); if (!e) return timeout(); src = { ip: e }; }
        else src = { ip: G.CLOUD_SHELL_IP };
      }
      if (!v || v.status !== 'RUNNING') return timeout();
      if (me && v === me) return v.listen[port] ? serveVm(sys, v, req, u) : { error: 7, msg: `Failed to connect to ${ip} port ${port} after 0 ms: Couldn't connect to server` };
      const r = G.reach(w, src, v, 'tcp', port);
      if (!r.ok) return timeout();
      if (!v.listen[port] || w.t < (v.readyAt || 0)) return { error: 7, msg: `Failed to connect to ${ip} port ${port} after 2 ms: Couldn't connect to server` };
      return serveVm(sys, v, req, u);
    },
  });
  // ifconfig.me：自分の外向きの IP アドレス
  G.ROUTES.push({
    name: 'ifconfig',
    match: (w, u) => u.hostname === 'ifconfig.me' || u.hostname === 'api.ipify.org',
    handle: (sys) => {
      if (sys.vm) { const e = G.egress(sys.w, sys.vm); if (!e) { const ct = sys.lastReq && sys.lastReq.connTimeout; const ms = (ct || 130) * 1000 + 2; return { error: 28, wait: ms, msg: `Failed to connect to ifconfig.me port 80 after ${ms} ms: ${ct ? 'Timeout was reached' : 'Couldn' + "'" + 't connect to server'}` }; } return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: e }; }
      return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: G.CLOUD_SHELL_IP };
    },
  });
  // メタデータサーバ（VM の中からだけ）
  G.ROUTES.push({
    name: 'metadata',
    match: (w, u) => u.hostname === 'metadata.google.internal' || u.hostname === '169.254.169.254',
    handle: (sys, req, u) => {
      const v = sys.vm;
      if (!v) return { error: 6, msg: 'Could not resolve host: metadata.google.internal' };
      if ((req.headers['metadata-flavor'] || '').toLowerCase() !== 'google') return { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'metadata-flavor': 'Google' }, body: "Missing required header \"Metadata-Flavor\": \"Google\"\n" };
      const p = sys.w.projects[v.project];
      const path = u.pathname.replace(/^\/computeMetadata\/v1\//, '');
      const txt = (s) => ({ status: 200, headers: { 'content-type': 'application/text', 'metadata-flavor': 'Google' }, body: s });
      const sa = path.match(/^instance\/service-accounts\/(default|[^/]+)\/(email|token|scopes|identity|aliases)?\/?$/);
      if (sa) {
        if (!v.sa) return { status: 404, headers: {}, body: 'Not Found\n' };
        if (sa[2] === 'email') return txt(v.sa);
        if (sa[2] === 'scopes') return txt(v.scopes.map((s) => 'https://www.googleapis.com/auth/' + s).join('\n') + '\n');
        if (sa[2] === 'token') return G.json(200, { access_token: G.token(sys.w, v.sa), expires_in: 3599, token_type: 'Bearer' });
        if (sa[2] === 'identity') return txt(G.token(sys.w, v.sa, 'id'));
        return txt('default/\n' + v.sa + '/\n');
      }
      const map = {
        'project/project-id': v.project, 'project/numeric-project-id': p.projectNumber, 'instance/name': v.name, 'instance/hostname': `${v.name}.${v.zone}.c.${v.project}.internal`,
        'instance/zone': `projects/${p.projectNumber}/zones/${v.zone}`, 'instance/id': v.id, 'instance/machine-type': `projects/${p.projectNumber}/machineTypes/${v.type}`,
        'instance/network-interfaces/0/ip': v.ip, 'instance/network-interfaces/0/access-configs/0/external-ip': v.natIP || '', 'instance/tags': JSON.stringify(v.tags),
        'instance/service-accounts/': v.sa ? 'default/\n' + v.sa + '/\n' : '',
      };
      if (path.startsWith('instance/attributes/')) { const k = path.slice('instance/attributes/'.length); if (!k) return txt(Object.keys(v.meta).join('\n') + '\n'); if (v.meta[k] === undefined) return { status: 404, headers: {}, body: 'Not Found\n' }; return txt(v.meta[k]); }
      if (map[path] === undefined) return { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: 'Not Found\n' };
      return txt(map[path]);
    },
  });

  // ---------------------------------------------------------------- gcloud compute ssh
  G.gc('compute ssh', { pos: ['[USER@]INSTANCE'], flags: { zone: 'v', command: 'v', 'tunnel-through-iap': 'b', 'internal-ip': 'b', 'ssh-flag': 'v*', 'strict-host-key-checking': 'v', 'dry-run': 'b' }, run: async (c) => {
    const name = c.p[0].replace(/^[^@]*@/, '');
    const v = getVm(c, name, 'compute.instances.get', { guess: true });
    const pid = v.project;
    // ssh の鍵を作って、プロジェクトのメタデータに入れる（最初の 1 回）
    if (!C(c.w).sshKey) {
      C(c.w).sshKey = true;
      c.err(`WARNING: The private SSH key file for gcloud does not exist.\nWARNING: The public SSH key file for gcloud does not exist.\nWARNING: You do not have an SSH key for gcloud.\nWARNING: SSH keygen will be executed to generate a key.\nGenerating public/private rsa key pair.\nYour identification has been saved in /home/you/.ssh/google_compute_engine\nYour public key has been saved in /home/you/.ssh/google_compute_engine.pub\nUpdating project ssh metadata...done.\nWaiting for SSH key to propagate.\n`);
    }
    if (!G.check(c.w, c.as(), 'compute.instances.setMetadata', `projects/${pid}/zones/${v.zone}/instances/${v.name}`).ok && !G.check(c.w, c.as(), 'compute.instances.osLogin', `projects/${pid}/zones/${v.zone}/instances/${v.name}`).ok) throw fetchErr(`Required 'compute.projects.get' permission for 'projects/${pid}'`);
    const fail = (msg) => { c.err(msg); c.err(`ERROR: (gcloud.compute.ssh) [/usr/bin/ssh] exited with return code [255].\n`); c.exit = 255; };
    if (v.status !== 'RUNNING') throw E.plain(`The instance ${v.name} is not running.`);
    if (!c.a['tunnel-through-iap'] && !v.natIP) { c.err('External IP address was not found; defaulting to using IAP tunneling.\n'); c.a['tunnel-through-iap'] = true; }
    if (c.a['tunnel-through-iap']) {
      const r = G.reach(c.w, { ip: '35.235.240.1' }, v, 'tcp', 22);
      if (!r.ok) { G.advance(c.w, 30000); return fail(`ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4003: 'failed to connect to backend']. (Failed to connect to port 22)\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535\n`); }
      c.err('External IP address was not found; defaulting to using IAP tunneling.\n'.replace(/.*\n/, ''));
    } else {
      if (!v.natIP) throw E.plain(`Instance [${v.name}] in zone [${v.zone}] does not have an external IP address, so you cannot SSH into it. To add an external IP address to the instance, use [gcloud compute instances add-access-config].`);
      const r = G.reach(c.w, { ip: G.CLOUD_SHELL_IP }, v, 'tcp', 22);
      if (!r.ok) { G.advance(c.w, 60000); return fail(`ssh: connect to host ${v.natIP} port 22: Connection timed out\n`); }
    }
    if (!c.a.command) throw E.plain('このサイトの gcloud compute ssh は、--command="…" で 1 回だけコマンドを実行する使い方だけに対応しています（本物では、VM の端末に入ります）。');
    const r = await G.vmRun(c.sys, v, c.a.command, { stdin: c.stdin });
    for (const o of r.out) (o.s === 'out' ? c.out : c.err)(o.text);
    c.exit = r.exit;
  } });

  // ---------------------------------------------------------------- ディスクとスナップショット
  G.gc('compute disks list', { flags: { zones: 'v' }, fmt: 'table(name, zone.basename():label=LOCATION, location_scope:label=LOCATION_SCOPE, sizeGb, type.basename(), status)', run: async (c) => {
    need(c, 'compute.disks.list', null, { list: true });
    return Object.values(C(c.w).disks).filter((d) => d.project === c.project).sort((a, b) => (a.name < b.name ? -1 : 1)).map((d) => ({ name: d.name, zone: API + `${d.project}/zones/${d.zone}`, location_scope: 'zone', sizeGb: String(d.size), type: API + `${d.project}/zones/${d.zone}/diskTypes/${d.type}`, status: 'READY', users: d.user ? [API + `${d.project}/zones/${d.zone}/instances/${d.user}`] : undefined }));
  } });
  G.gc('compute disks snapshot', { pos: ['DISK_NAME …'], flags: { zone: 'v', 'snapshot-names': 'v', 'storage-location': 'v' }, run: async (c) => {
    const pid = c.need();
    const zone = c.zone();
    if (!zone) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--zone] flag.`);
    need(c, 'compute.disks.createSnapshot', null, {});
    const names = c.a['snapshot-names'] ? c.a['snapshot-names'].split(',') : c.p.map((d) => `${d}-${G.alnum('snap' + G.seq(c.w, 'snap'), 8)}`);
    c.p.forEach((dn, k) => {
      const d = C(c.w).disks[`${pid}/${zone}/${dn}`];
      if (!d) throw fetchErr(`The resource 'projects/${pid}/zones/${zone}/disks/${dn}' was not found`);
      const vm = C(c.w).vms[`${pid}/${zone}/${dn}`];
      C(c.w).snaps[`${pid}/${names[k]}`] = { project: pid, name: names[k], disk: dn, zone, size: d.size, created: c.w.t, location: c.a['storage-location'] || regionOf(zone).split('-')[0], files: vm && vm.sh ? G.clone(vm.sh) : null };
      c.err(`Creating snapshot(s) ${names[k]}...\n`);
    });
    G.tick(c.w, 20000);
    c.err('...done.\n');
  } });
  G.gc('compute snapshots list', { fmt: 'table(name, diskSizeGb:label=DISK_SIZE_GB, sourceDisk.segment(-3):label=SRC_DISK, status)', run: async (c) => {
    need(c, 'compute.snapshots.list', null, { list: true });
    return Object.values(C(c.w).snaps).filter((s) => s.project === c.project).map((s) => ({ name: s.name, diskSizeGb: String(s.size), sourceDisk: API + `${s.project}/zones/${s.zone}/disks/${s.disk}`, status: 'READY', storageLocations: [s.location] }));
  } });

  // ---------------------------------------------------------------- 静的な外部 IP アドレス
  G.gc('compute addresses create', { pos: ['NAME …'], flags: { region: 'v', global: 'b', addresses: 'v' }, run: async (c) => {
    const pid = c.need();
    const region = c.a.global ? 'global' : c.a.region || G.cfgGet(c.w, 'compute/region');
    if (!region) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--region] flag.`);
    need(c, 'compute.addresses.create', null, { method: 'addresses.insert', resType: 'gce_address' });
    for (const n of c.p) {
      if (C(c.w).addrs[`${pid}/${region}/${n}`]) throw fetchErr(`The resource 'projects/${pid}/regions/${region}/addresses/${n}' already exists`);
      C(c.w).addrs[`${pid}/${region}/${n}`] = { project: pid, region, name: n, ip: externalIp(c.w, region), user: null, created: c.w.t };
      c.err(`Created [${API}${pid}/regions/${region}/addresses/${n}].\n`);
    }
  } });
  G.gc('compute addresses list', { fmt: 'table(name, address, addressType:label=TYPE, purpose, network.basename(), region.basename(), subnetwork.basename(), status)', run: async (c) => {
    need(c, 'compute.addresses.list', null, { list: true });
    return Object.values(C(c.w).addrs).filter((a) => a.project === c.project).map((a) => ({ name: a.name, address: a.ip, addressType: 'EXTERNAL', region: API + `${a.project}/regions/${a.region}`, status: a.user ? 'IN_USE' : 'RESERVED', users: a.user ? [a.user] : undefined }));
  } });
  G.gc('compute addresses delete', { pos: ['NAME …'], flags: { region: 'v', global: 'b' }, run: async (c) => {
    const pid = c.need();
    const region = c.a.global ? 'global' : c.a.region || G.cfgGet(c.w, 'compute/region');
    need(c, 'compute.addresses.delete');
    c.confirm(`The following addresses will be deleted:\n${c.p.map((n) => ` - [${n}] in [${region}]`).join('\n')}`);
    for (const n of c.p) {
      const a = C(c.w).addrs[`${pid}/${region}/${n}`];
      if (!a) throw fetchErr(`The resource 'projects/${pid}/regions/${region}/addresses/${n}' was not found`);
      if (a.user) throw fetchErr(`The address resource 'projects/${pid}/regions/${region}/addresses/${n}' is already being used by 'projects/${a.user.split('/')[0]}/zones/${a.user.split('/')[1]}/instances/${a.user.split('/')[2]}'`);
      delete C(c.w).addrs[`${pid}/${region}/${n}`];
      c.err(`Deleted [${API}${pid}/regions/${region}/addresses/${n}].\n`);
    }
  } });

  // ---------------------------------------------------------------- VPC ネットワーク
  const netView = (n) => ({ autoCreateSubnetworks: n.mode === 'auto', creationTimestamp: ctime(n.created), id: n.id, kind: 'compute#network', mtu: n.mtu, name: n.name, routingConfig: { routingMode: n.routing }, selfLink: API + `${n.project}/global/networks/${n.name}`, x_gcloud_subnet_mode: n.mode === 'auto' ? 'AUTO' : 'CUSTOM', x_gcloud_bgp_routing_mode: n.routing, networkFirewallPolicyEnforcementOrder: 'AFTER_CLASSIC_FIREWALL' });
  const NET_FMT = 'table(name, x_gcloud_subnet_mode:label=SUBNET_MODE, x_gcloud_bgp_routing_mode:label=BGP_ROUTING_MODE, IPv4Range:label=IPV4_RANGE, gatewayIPv4:label=GATEWAY_IPV4)';
  G.gc('compute networks list', { fmt: NET_FMT, run: async (c) => {
    need(c, 'compute.networks.list', null, { list: true });
    return Object.values(C(c.w).nets).filter((n) => n.project === c.project).sort((a, b) => (a.name < b.name ? -1 : 1)).map(netView);
  } });
  G.gc('compute networks describe', { pos: ['NAME'], fmt: 'yaml', run: async (c) => {
    need(c, 'compute.networks.get');
    const n = C(c.w).nets[`${c.project}/${c.p[0]}`];
    if (!n) throw fetchErr(`The resource 'projects/${c.project}/global/networks/${c.p[0]}' was not found`);
    const v = netView(n);
    v.subnetworks = Object.values(C(c.w).subnets).filter((s) => s.project === n.project && s.network === n.name).map((s) => API + `${s.project}/regions/${s.region}/subnetworks/${s.name}`);
    delete v.x_gcloud_subnet_mode; delete v.x_gcloud_bgp_routing_mode;
    return v;
  } });
  G.gc('compute networks create', { pos: ['NAME'], flags: { 'subnet-mode': 'v', 'bgp-routing-mode': 'v', mtu: 'v', description: 'v' }, fmt: NET_FMT, run: async (c) => {
    const pid = c.need();
    need(c, 'compute.networks.create', null, { method: 'networks.insert', resType: 'gce_network' });
    const name = c.p[0];
    if (C(c.w).nets[`${pid}/${name}`]) throw fetchErr(`The resource 'projects/${pid}/global/networks/${name}' already exists`);
    const mode = (c.a['subnet-mode'] || 'auto').toLowerCase();
    const n = C(c.w).nets[`${pid}/${name}`] = { project: pid, name, mode, routing: (c.a['bgp-routing-mode'] || 'regional').toUpperCase(), created: c.w.t, mtu: Number(c.a.mtu || 1460), id: G.digits('net' + pid + name, 19) };
    if (mode === 'auto') for (const [r, , range] of REGIONS) C(c.w).subnets[`${pid}/${r}/${name}`] = { project: pid, region: r, name, network: name, range, pga: false, created: c.w.t, id: G.digits('sub' + pid + r + name, 19), gw: range.replace(/0\/20$/, '1') };
    c.err(`Created [${API}${pid}/global/networks/${name}].\n`);
    G.tick(c.w, 10000);
    c.out(G.fmt.print([netView(n)], c.a.format, NET_FMT));
    c.err(`\nInstances on this network will not be reachable until firewall rules\nare created. As an example, you can allow all internal traffic between\ninstances as well as SSH, RDP, and ICMP by running:\n\n$ gcloud compute firewall-rules create <FIREWALL_NAME> --network ${name} --allow tcp,udp,icmp --source-ranges <IP_RANGE>\n$ gcloud compute firewall-rules create <FIREWALL_NAME> --network ${name} --allow tcp:22,tcp:3389,icmp\n\n`);
  } });
  G.gc('compute networks delete', { pos: ['NAME …'], run: async (c) => {
    const pid = c.need();
    need(c, 'compute.networks.delete');
    c.confirm(`The following networks will be deleted:\n${c.p.map((n) => ` - [${n}]`).join('\n')}`);
    for (const name of c.p) {
      if (!C(c.w).nets[`${pid}/${name}`]) throw fetchErr(`The resource 'projects/${pid}/global/networks/${name}' was not found`);
      const fw = Object.values(C(c.w).fws).find((f) => f.project === pid && f.network === name);
      if (fw) throw fetchErr(`The network resource 'projects/${pid}/global/networks/${name}' is already being used by 'projects/${pid}/global/firewalls/${fw.name}'`);
      const vm = Object.values(C(c.w).vms).find((v) => v.project === pid && v.network === name);
      if (vm) throw fetchErr(`The network resource 'projects/${pid}/global/networks/${name}' is already being used by 'projects/${pid}/zones/${vm.zone}/instances/${vm.name}'`);
      const sub = Object.values(C(c.w).subnets).find((s) => s.project === pid && s.network === name && C(c.w).nets[`${pid}/${name}`].mode === 'custom');
      if (sub) throw fetchErr(`The network resource 'projects/${pid}/global/networks/${name}' is already being used by 'projects/${pid}/regions/${sub.region}/subnetworks/${sub.name}'`);
      for (const k of Object.keys(C(c.w).subnets)) if (C(c.w).subnets[k].project === pid && C(c.w).subnets[k].network === name) delete C(c.w).subnets[k];
      delete C(c.w).nets[`${pid}/${name}`];
      c.err(`Deleted [${API}${pid}/global/networks/${name}].\n`);
    }
  } });
  const subView = (s) => ({ creationTimestamp: ctime(s.created), fingerprint: 'nJqsq0ZjLxw=', gatewayAddress: s.gw, id: s.id, ipCidrRange: s.range, kind: 'compute#subnetwork', name: s.name, network: API + `${s.project}/global/networks/${s.network}`, privateIpGoogleAccess: s.pga, purpose: 'PRIVATE', region: API + `${s.project}/regions/${s.region}`, selfLink: API + `${s.project}/regions/${s.region}/subnetworks/${s.name}`, stackType: 'IPV4_ONLY' });
  const SUB_FMT = 'table(name, region.basename(), network.basename(), ipCidrRange:label=RANGE, stackType, ipv6AccessType, internalIpv6Prefix, externalIpv6Prefix)';
  G.gc('compute networks subnets list', { flags: { network: 'v', regions: 'v' }, fmt: SUB_FMT, run: async (c) => {
    need(c, 'compute.subnetworks.list', null, { list: true });
    return Object.values(C(c.w).subnets).filter((s) => s.project === c.project && (!c.a.network || s.network === c.a.network) && (!c.a.regions || c.a.regions.split(',').includes(s.region)))
      .sort((a, b) => (a.name + a.region < b.name + b.region ? -1 : 1)).map(subView);
  } });
  G.gc('compute networks subnets describe', { pos: ['NAME'], flags: { region: 'v' }, fmt: 'yaml', run: async (c) => {
    need(c, 'compute.subnetworks.get');
    const region = c.a.region || G.cfgGet(c.w, 'compute/region');
    if (!region) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--region] flag.`);
    const s = C(c.w).subnets[`${c.project}/${region}/${c.p[0]}`];
    if (!s) throw fetchErr(`The resource 'projects/${c.project}/regions/${region}/subnetworks/${c.p[0]}' was not found`);
    return subView(s);
  } });
  G.gc('compute networks subnets create', { pos: ['NAME'], flags: { network: 'v', region: 'v', range: 'v', 'enable-private-ip-google-access': 'b', description: 'v' }, req: ['network', 'range'], fmt: SUB_FMT, run: async (c) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'compute/region');
    if (!region) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--region] flag.`);
    need(c, 'compute.subnetworks.create', null, { method: 'subnetworks.insert', resType: 'gce_subnetwork' });
    const n = C(c.w).nets[`${pid}/${c.a.network}`];
    if (!n) throw fetchErr(`The resource 'projects/${pid}/global/networks/${c.a.network}' was not found`);
    if (n.mode === 'auto') throw fetchErr(`Invalid resource usage: 'Cannot create subnetwork in auto subnet mode network.'.`);
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c.a.range)) throw fetchErr(`Invalid value for field 'resource.ipCidrRange': '${c.a.range}'. Invalid IPCidrRange: ${c.a.range} conflicts with existing subnetwork.`);
    const bits = Number(c.a.range.split('/')[1]);
    if (bits > 29) throw fetchErr(`Invalid value for field 'resource.ipCidrRange': '${c.a.range}'. Invalid IPCidrRange: ${c.a.range}. The range must be at least /29.`);
    const clash = Object.values(C(c.w).subnets).find((s) => s.project === pid && s.network === c.a.network && (inRange(c.a.range.split('/')[0], s.range) || inRange(s.range.split('/')[0], c.a.range)));
    if (clash) throw fetchErr(`Invalid IPCidrRange: ${c.a.range} conflicts with existing subnetwork '${clash.name}' in region '${clash.region}'.`);
    const s = C(c.w).subnets[`${pid}/${region}/${c.p[0]}`] = { project: pid, region, name: c.p[0], network: c.a.network, range: c.a.range, pga: !!c.a['enable-private-ip-google-access'], created: c.w.t, id: G.digits('sub' + pid + region + c.p[0], 19), gw: numIp(ipNum(c.a.range.split('/')[0]) + 1) };
    c.err(`Created [${API}${pid}/regions/${region}/subnetworks/${c.p[0]}].\n`);
    G.tick(c.w, 8000);
    return [subView(s)];
  } });
  G.gc('compute networks subnets update', { pos: ['NAME'], flags: { region: 'v', 'enable-private-ip-google-access': 'b' }, run: async (c) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'compute/region');
    need(c, 'compute.subnetworks.update');
    const s = C(c.w).subnets[`${pid}/${region}/${c.p[0]}`];
    if (!s) throw fetchErr(`The resource 'projects/${pid}/regions/${region}/subnetworks/${c.p[0]}' was not found`);
    if (c.a['enable-private-ip-google-access'] !== undefined) s.pga = c.a['enable-private-ip-google-access'];
    c.err(`Updated [${API}${pid}/regions/${region}/subnetworks/${c.p[0]}].\n`);
  } });
  // VM から Google の API に届くか（外部 IP、NAT、限定公開の Google アクセス）。届かなければ、gcloud は待ってから失敗する
  G.googleReach = (w, vm) => {
    if (!vm) return true;
    if (G.egress(w, vm)) return true;
    const s = C(w).subnets[`${vm.project}/${regionOf(vm.zone)}/${vm.subnet}`];
    return !!(s && s.pga);
  };

  // ---------------------------------------------------------------- ファイアウォールのルール
  const fwView = (f) => Object.assign({ creationTimestamp: ctime(f.created), description: f.desc || '', direction: f.direction || 'INGRESS', disabled: f.disabled, id: f.id, kind: 'compute#firewall', logConfig: { enable: false }, name: f.name, network: API + `${f.project}/global/networks/${f.network}`, priority: f.priority, selfLink: API + `${f.project}/global/firewalls/${f.name}`, sourceRanges: f.sources.length ? f.sources : undefined, targetTags: f.targets.length ? f.targets : undefined, sourceTags: (f.sourceTags || []).length ? f.sourceTags : undefined, destinationRanges: (f.dests || []).length ? f.dests : undefined },
    f.allow ? { allowed: f.allow } : { denied: f.deny });
  const rulesTxt = (list) => (list || []).map((a) => a.IPProtocol + (a.ports ? ':' + a.ports.join(',') : '')).join(',');
  const FW_FMT = 'table(name, network.basename(), direction, priority, allowed[].map().firewall_rule().list():label=ALLOW, denied[].map().firewall_rule().list():label=DENY, disabled)';
  const fwRow = (f) => Object.assign(fwView(f), { ALLOW: rulesTxt(f.allow), DENY: rulesTxt(f.deny) });
  const FW_TABLE = 'table(name, network.basename(), direction, priority, ALLOW, DENY, disabled)';
  G.gc('compute firewall-rules list', { fmt: FW_TABLE, run: async (c) => {
    need(c, 'compute.firewalls.list', null, { list: true });
    const rows = Object.values(C(c.w).fws).filter((f) => f.project === c.project).sort((a, b) => (a.name < b.name ? -1 : 1)).map(fwRow);
    if (!c.a.format && rows.length) setTimeout && 0;
    return rows;
  }, emptyMsg: 'Listed 0 items.\n' });
  G.gc('compute firewall-rules describe', { pos: ['NAME'], fmt: 'yaml', run: async (c) => {
    need(c, 'compute.firewalls.get');
    const f = C(c.w).fws[`${c.project}/${c.p[0]}`];
    if (!f) throw fetchErr(`The resource 'projects/${c.project}/global/firewalls/${c.p[0]}' was not found`);
    return fwView(f);
  } });
  const parseRules = (s) => s.split(',').map((x) => { const [proto, ports] = x.split(':'); return Object.assign({ IPProtocol: proto }, ports ? { ports: [ports] } : {}); })
    .reduce((acc, r) => { const prev = acc.find((x) => x.IPProtocol === r.IPProtocol && x.ports && r.ports); if (prev) prev.ports.push(...r.ports); else acc.push(r); return acc; }, []);
  G.gc('compute firewall-rules create', { pos: ['NAME'], flags: { network: 'v', allow: 'v', action: 'v', rules: 'v', 'source-ranges': 'v', 'source-tags': 'v', 'target-tags': 'v', 'target-service-accounts': 'v', direction: 'v', priority: 'v', description: 'v', 'destination-ranges': 'v', disabled: 'b', 'enable-logging': 'b' }, fmt: FW_TABLE, run: async (c) => {
    const pid = c.need();
    need(c, 'compute.firewalls.create', null, { method: 'firewalls.insert', resType: 'gce_firewall_rule' });
    const name = c.p[0];
    const net = c.a.network || 'default';
    if (!C(c.w).nets[`${pid}/${net}`]) throw fetchErr(`The resource 'projects/${pid}/global/networks/${net}' was not found`);
    if (C(c.w).fws[`${pid}/${name}`]) throw fetchErr(`The resource 'projects/${pid}/global/firewalls/${name}' already exists`);
    let allow = null, deny = null;
    if (c.a.allow) allow = parseRules(c.a.allow);
    else if (c.a.action) { const r = parseRules(c.a.rules || 'all'); if (c.a.action.toUpperCase() === 'ALLOW') allow = r; else deny = r; }
    else throw E.usage('Exactly one of (--action | --allow) must be specified.');
    const dir = (c.a.direction || 'INGRESS').toUpperCase().replace(/^IN$/, 'INGRESS').replace(/^OUT$/, 'EGRESS');
    const f = C(c.w).fws[`${pid}/${name}`] = { project: pid, name, network: net, direction: dir, priority: Number(c.a.priority || 1000), allow, deny,
      sources: c.a['source-ranges'] ? c.a['source-ranges'].split(',') : (c.a['source-tags'] || dir === 'EGRESS' ? [] : ['0.0.0.0/0']), sourceTags: c.a['source-tags'] ? c.a['source-tags'].split(',') : [], targets: c.a['target-tags'] ? c.a['target-tags'].split(',') : [],
      targetSAs: c.a['target-service-accounts'] ? c.a['target-service-accounts'].split(',') : [], dests: c.a['destination-ranges'] ? c.a['destination-ranges'].split(',') : [], disabled: !!c.a.disabled, created: c.w.t, id: G.digits('fw' + pid + name, 19), desc: c.a.description || '' };
    c.err(`Creating firewall...done.\nCreated [${API}${pid}/global/firewalls/${name}].\n`);
    G.tick(c.w, 8000);
    return [fwRow(f)];
  } });
  G.gc('compute firewall-rules update', { pos: ['NAME'], flags: { allow: 'v', rules: 'v', 'source-ranges': 'v', 'target-tags': 'v', priority: 'v', disabled: 'b', description: 'v' }, run: async (c) => {
    const pid = c.need();
    need(c, 'compute.firewalls.update');
    const f = C(c.w).fws[`${pid}/${c.p[0]}`];
    if (!f) throw fetchErr(`The resource 'projects/${pid}/global/firewalls/${c.p[0]}' was not found`);
    if (c.a.allow) f.allow = parseRules(c.a.allow);
    if (c.a.rules) { if (f.allow) f.allow = parseRules(c.a.rules); else f.deny = parseRules(c.a.rules); }
    if (c.a['source-ranges'] !== undefined) f.sources = c.a['source-ranges'].split(',').filter(Boolean);
    if (c.a['target-tags'] !== undefined) f.targets = c.a['target-tags'].split(',').filter(Boolean);
    if (c.a.priority) f.priority = Number(c.a.priority);
    if (c.a.disabled !== undefined) f.disabled = c.a.disabled;
    c.err(`Updating firewall...done.\nUpdated [${API}${pid}/global/firewalls/${c.p[0]}].\n`);
  } });
  G.gc('compute firewall-rules delete', { pos: ['NAME …'], run: async (c) => {
    const pid = c.need();
    need(c, 'compute.firewalls.delete');
    c.confirm(`The following firewalls will be deleted:\n${c.p.map((n) => ` - [${n}]`).join('\n')}`);
    for (const n of c.p) {
      if (!C(c.w).fws[`${pid}/${n}`]) throw fetchErr(`The resource 'projects/${pid}/global/firewalls/${n}' was not found`);
      delete C(c.w).fws[`${pid}/${n}`];
      c.err(`Deleted [${API}${pid}/global/firewalls/${n}].\n`);
    }
  } });

  // ---------------------------------------------------------------- Cloud Router と Cloud NAT
  G.gc('compute routers create', { pos: ['NAME'], flags: { network: 'v', region: 'v', asn: 'v' }, req: ['network'], run: async (c) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'compute/region');
    if (!region) throw E.plain(`Underspecified resource [${c.p[0]}]. Specify the [--region] flag.`);
    need(c, 'compute.routers.create', null, { method: 'routers.insert', resType: 'gce_router' });
    if (!C(c.w).nets[`${pid}/${c.a.network}`]) throw fetchErr(`The resource 'projects/${pid}/global/networks/${c.a.network}' was not found`);
    C(c.w).routers[`${pid}/${region}/${c.p[0]}`] = { project: pid, region, name: c.p[0], network: c.a.network, nat: null };
    c.err(`Creating router [${c.p[0]}]...done.\n`);
    c.out(`NAME        REGION           NETWORK\n`.replace(/NAME {8}/, 'NAME'.padEnd(Math.max(4, c.p[0].length) + 2)).replace(/REGION {11}/, 'REGION'.padEnd(Math.max(6, region.length) + 2)) + `${c.p[0].padEnd(Math.max(4, c.p[0].length) + 2)}${region.padEnd(Math.max(6, region.length) + 2)}${c.a.network}\n`);
    G.tick(c.w, 6000);
  } });
  G.gc('compute routers nats create', { pos: ['NAME'], flags: { router: 'v', region: 'v', 'auto-allocate-nat-external-ips': 'b', 'nat-all-subnet-ip-ranges': 'b', 'nat-custom-subnet-ip-ranges': 'v', 'enable-logging': 'b' }, req: ['router'], run: async (c) => {
    const pid = c.need();
    const region = c.a.region || G.cfgGet(c.w, 'compute/region');
    need(c, 'compute.routers.update', null, { method: 'routers.patch', resType: 'gce_router' });
    const r = C(c.w).routers[`${pid}/${region}/${c.a.router}`];
    if (!r) throw fetchErr(`The resource 'projects/${pid}/regions/${region}/routers/${c.a.router}' was not found`);
    r.nat = { name: c.p[0], ip: externalIp(c.w, region) };
    c.err(`Creating NAT [${c.p[0]}] in router [${c.a.router}]...done.\n`);
    G.tick(c.w, 30000);
  } });
  G.gc('compute routers list', { fmt: 'table(name, region.basename(), network.basename())', run: async (c) => {
    need(c, 'compute.routers.list', null, { list: true });
    return Object.values(C(c.w).routers).filter((r) => r.project === c.project).map((r) => ({ name: r.name, region: API + `${r.project}/regions/${r.region}`, network: API + `${r.project}/global/networks/${r.network}`, nats: r.nat ? [{ name: r.nat.name, natIpAllocateOption: 'AUTO_ONLY', sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES' }] : undefined }));
  } });
})(typeof window !== 'undefined' ? window : globalThis);
