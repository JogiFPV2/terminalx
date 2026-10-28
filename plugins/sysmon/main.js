// Monitor zasobów: CPU i RAM systemu na pasku statusu.

let timer = null;
let item = null;

/** @param {import('../sdk/terminalx-plugin').TxApi} tx */
export function activate(tx) {
  item = tx.ui.statusBar.createItem({ id: 'sysmon', alignment: 'right', priority: 50 });
  item.icon = 'activity';
  item.text = 'CPU –';
  item.show();

  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

  const tick = async () => {
    const { cpu, memUsed, memTotal } = await tx.system.stats();
    const ram = Math.round((memUsed / memTotal) * 100);
    const parts = [];
    if (tx.config.get('showCpu')) parts.push(`CPU ${Math.round(cpu)}%`);
    if (tx.config.get('showRam')) parts.push(`RAM ${ram}%`);
    item.text = parts.join(' · ') || 'Monitor';
    item.tooltip = `Procesor: ${cpu.toFixed(1)}%\nPamięć: ${gb(memUsed)} / ${gb(memTotal)} GB`;
    item.variant = Math.max(cpu, ram) >= tx.config.get('warnAtPercent') ? 'warning' : 'default';
  };

  const start = () => {
    clearInterval(timer);
    timer = setInterval(tick, Math.max(1, tx.config.get('intervalSec')) * 1000);
    tick();
  };
  tx.config.onChange(start);
  start();
}

export function deactivate() {
  clearInterval(timer);
  item?.dispose();
}
