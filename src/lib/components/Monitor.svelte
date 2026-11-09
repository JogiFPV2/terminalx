<script lang="ts">
  // Monitoring: ten komputer i wybrane hosty SSH. Odpytuje tylko, gdy zakładka jest otwarta;
  // host to jedna komenda przez istniejące połączenie SSH (odczyt /proc), bez agenta na serwerze.
  import { untrack } from 'svelte';
  import Icon from '../Icon.svelte';
  import { app, ui } from '../state.svelte';
  import { call, isTauri } from '../ipc';
  import { hostCfg } from '../hosts.svelte';
  import type { MenuItem } from '../state.svelte';

  type Sample = { cpu: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; rx: number; tx: number; gpu: { util: number; memUsed: number; memTotal: number } | null };
  type Row = { id: string; name: string; s?: Sample; down?: number; up?: number; ping?: number; err?: string; hist: number[]; prev?: { t: number; rx: number; tx: number; busy?: number; total?: number } };

  const COLS: Record<string, string> = { cpu: 'CPU', mem: 'RAM', disk: 'Dysk', net: 'Sieć', gpu: 'GPU', ping: 'Opóźnienie' };
  const REMOTE = `export LC_ALL=C; head -1 /proc/stat; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; df -kP / | tail -1 | awk '{print "DISK",$2*1024,$3*1024}'; awk 'NR>2 && $1!~/^lo:/{rx+=$2;tx+=$10} END{print "NET",rx,tx}' /proc/net/dev; nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | sed 's/ //g;s/^/GPU,/'`;

  let rows = $state<Record<string, Row>>({});
  const cfg = app.monitor;
  const shown = $derived(['local', ...cfg.hosts.filter((id) => app.hosts.some((h) => h.id === id))]);
  const nameOf = (id: string) => (id === 'local' ? 'Ten komputer' : app.hosts.find((h) => h.id === id)?.name || id);

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const size = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`).replace('.', ',');
  const rate = (b?: number) => (b == null ? '–' : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB/s` : `${Math.round(b / 1024)} kB/s`);

  function parseRemote(out: string): Sample & { busy: number; total: number } {
    const cpu = out.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) || [];
    const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0), idle = (cpu[3] || 0) + (cpu[4] || 0);
    const kb = (k: string) => +(out.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    const disk = out.match(/^DISK (\d+) (\d+)/m), net = out.match(/^NET (\d+) (\d+)/m), gpu = out.match(/^GPU,([\d.]+),(\d+),(\d+)/m);
    return {
      cpu: 0, busy: total - idle, total,
      memTotal: kb('MemTotal'), memUsed: kb('MemTotal') - kb('MemAvailable'),
      diskTotal: +(disk?.[1] || 0), diskUsed: +(disk?.[2] || 0), rx: +(net?.[1] || 0), tx: +(net?.[2] || 0),
      gpu: gpu ? { util: +gpu[1], memUsed: +gpu[2] * 1024 ** 2, memTotal: +gpu[3] * 1024 ** 2 } : null,
    };
  }

  async function poll(id: string) {
    const r = (rows[id] ??= { id, name: nameOf(id), hist: [] });
    const t0 = performance.now();
    try {
      let s: Sample;
      let cpuRaw: { busy: number; total: number } | null = null;
      if (id === 'local') s = await call<Sample>('mon_local');
      else {
        const h = app.hosts.find((x) => x.id === id);
        if (!h) return;
        const res = await call<{ stdout: string }>('ssh_exec', { host: hostCfg(h), command: REMOTE });
        const p = parseRemote(res.stdout);
        if (!p.memTotal) throw new Error('Host nie udostępnia /proc (obsługiwany jest Linux)');
        cpuRaw = p;
        s = p;
        if (r.prev?.total != null && p.total > r.prev.total) s.cpu = ((p.busy - (r.prev.busy || 0)) / (p.total - r.prev.total)) * 100;
        else s.cpu = r.s?.cpu ?? 0;
      }
      const t = performance.now();
      if (id !== 'local') r.ping = Math.round(t - t0);
      if (r.prev) { const dt = (t - r.prev.t) / 1000; r.down = Math.max(0, (s.rx - r.prev.rx) / dt); r.up = Math.max(0, (s.tx - r.prev.tx) / dt); }
      r.prev = { t, rx: s.rx, tx: s.tx, busy: cpuRaw?.busy, total: cpuRaw?.total };
      r.s = s;
      r.err = undefined;
      r.hist = [...r.hist.slice(-39), s.cpu];
    } catch (e) {
      r.err = String(e).replace(/^Error: /, '');
    }
  }

  let busy = new Set<string>();
  function tick() {
    for (const id of shown) {
      if (busy.has(id)) continue; // wolny host nie blokuje pozostałych
      busy.add(id);
      poll(id).finally(() => busy.delete(id));
    }
  }

  // Odpytywanie tylko, gdy zakładka jest otwarta; zmiana interwału albo listy hostów restartuje zegar.
  $effect(() => {
    if (!isTauri) return;
    const ms = Math.max(1, cfg.interval) * 1000;
    void shown.length;
    untrack(tick);
    const t = window.setInterval(() => untrack(tick), ms);
    return () => clearInterval(t);
  });

  const spark = (h: number[]) => h.map((v, i) => `${(i / 39) * 60},${18 - (Math.min(100, v) / 100) * 16}`).join(' ');

  function menu(e: MouseEvent, items: MenuItem[]) { ui.menu = { x: e.clientX, y: e.clientY, items }; }
  const colMenu = (e: MouseEvent) => menu(e, [{ heading: 'Kolumny' }, ...Object.entries(COLS).map(([k, label]) => ({
    label, icon: cfg.cols.includes(k) ? 'check' : undefined,
    run: () => { cfg.cols = cfg.cols.includes(k) ? cfg.cols.filter((c) => c !== k) : Object.keys(COLS).filter((c) => c === k || cfg.cols.includes(c)); },
  }))]);
  const hostMenu = (e: MouseEvent) => menu(e, app.hosts.length
    ? [{ heading: 'Hosty SSH' }, ...app.hosts.map((h) => ({ label: h.name || h.host, icon: cfg.hosts.includes(h.id) ? 'check' : undefined, run: () => { cfg.hosts = cfg.hosts.includes(h.id) ? cfg.hosts.filter((x) => x !== h.id) : [...cfg.hosts, h.id]; } }))]
    : [{ heading: 'Brak hostów – dodaj je w Hostach SSH' }]);
  const intMenu = (e: MouseEvent) => menu(e, [{ heading: 'Odświeżanie' }, ...[1, 2, 3, 5, 10, 30].map((s) => ({ label: `co ${s} s`, icon: cfg.interval === s ? 'check' : undefined, run: () => (cfg.interval = s) }))]);
</script>

<div class="mon">
  <div class="bar">
    <span class="title">Monitoring</span>
    <span class="spacer"></span>
    <button class="icobtn" title="Hosty SSH" onclick={hostMenu}><Icon name="hosts" size={14} /></button>
    <button class="icobtn" title="Kolumny" onclick={colMenu}><Icon name="list" size={14} /></button>
    <button class="icobtn" title="Odświeżanie co {cfg.interval} s" onclick={intMenu}><Icon name="clock" size={14} /></button>
  </div>
  <div class="grid" style:--n={cfg.cols.length}>
    <div class="row head"><span>Host</span>{#each cfg.cols as c}<span>{COLS[c]}</span>{/each}</div>
    {#each shown as id (id)}
      {@const r = rows[id]}
      {@const s = r?.s}
      <div class="row">
        <span class="name" title={r?.err || ''}><span class="dot" class:bad={!!r?.err} class:ok={!!s && !r?.err}></span>{nameOf(id)}</span>
        {#each cfg.cols as c}
          <span class="cell">
            {#if r?.err && !s}<span class="muted">{c === cfg.cols[0] ? r.err : ''}</span>
            {:else if !s}<span class="muted">…</span>
            {:else if c === 'cpu'}
              <b>{Math.round(s.cpu)}%</b>
              <svg class="spark" viewBox="0 0 60 20" preserveAspectRatio="none"><polyline points={spark(r.hist)} /></svg>
            {:else if c === 'mem'}<b>{pct(s.memUsed, s.memTotal)}%</b><span class="muted">{size(s.memUsed)} / {size(s.memTotal)}</span><i style:--p="{pct(s.memUsed, s.memTotal)}%"></i>
            {:else if c === 'disk'}<b>{pct(s.diskUsed, s.diskTotal)}%</b><span class="muted">{size(s.diskTotal - s.diskUsed)} wolne</span><i style:--p="{pct(s.diskUsed, s.diskTotal)}%"></i>
            {:else if c === 'net'}<span>↓ {rate(r.down)}</span><span class="muted">↑ {rate(r.up)}</span>
            {:else if c === 'gpu'}{#if s.gpu}<b>{Math.round(s.gpu.util)}%</b><span class="muted">{size(s.gpu.memUsed)} / {size(s.gpu.memTotal)}</span><i style:--p="{pct(s.gpu.memUsed, s.gpu.memTotal)}%"></i>{:else}<span class="muted">–</span>{/if}
            {:else if c === 'ping'}{#if id === 'local'}<span class="muted">–</span>{:else}<b>{r.ping ?? '–'}</b><span class="muted">ms</span>{/if}
            {/if}
          </span>
        {/each}
      </div>
    {/each}
  </div>
  {#if !app.hosts.length}<p class="hint">Hosty SSH z Vaulta możesz dodać ikoną hostów powyżej.</p>{/if}
</div>

<style>
  .mon { height: 100%; overflow: auto; padding: 10px 14px; background: var(--background); }
  .bar { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
  .title { font-weight: 600; }
  .spacer { flex: 1; }
  .grid { display: grid; grid-template-columns: minmax(140px, 1.2fr) repeat(var(--n), minmax(110px, 1fr)); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .row { display: contents; }
  .row > span { padding: 8px 10px; border-top: 1px solid var(--border); min-width: 0; }
  .head > span { border-top: none; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: var(--muted); }
  .name { display: flex; align-items: center; gap: 8px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground); flex: none; }
  .dot.ok { background: var(--chart-1); }
  .dot.bad { background: var(--destructive); }
  .cell { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; position: relative; font-variant-numeric: tabular-nums; }
  .cell b { font-weight: 600; }
  .muted { color: var(--muted-foreground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
  .cell i { position: absolute; left: 10px; right: 10px; bottom: 4px; height: 2px; border-radius: 2px; background: var(--muted); }
  .cell i::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--p); background: var(--primary); border-radius: 2px; }
  .spark { width: 60px; height: 18px; }
  .spark polyline { fill: none; stroke: var(--primary-ink); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
  .hint { color: var(--muted-foreground); font-size: 12px; margin-top: 10px; }
</style>
