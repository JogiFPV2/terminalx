// Pomodoro: odliczanie pracy i przerwy na pasku statusu.

let item = null;
let timer = null;

/** @param {import('../sdk/hermitty-plugin').TxApi} tx */
export function activate(tx) {
  let phase = 'work';
  let running = false;
  let left = tx.config.get('workMinutes') * 60;

  item = tx.ui.statusBar.createItem({ id: 'pomodoro', alignment: 'right', priority: 60 });
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const draw = () => {
    item.icon = running ? 'pause' : 'timer';
    item.text = mmss(left);
    item.tooltip = `${phase === 'work' ? 'Praca' : 'Przerwa'} · kliknij, żeby ${running ? 'wstrzymać' : 'wystartować'}`;
    item.variant = phase === 'break' ? 'warning' : 'default';
  };

  const finish = () => {
    const wasWork = phase === 'work';
    phase = wasWork ? 'break' : 'work';
    left = tx.config.get(wasWork ? 'breakMinutes' : 'workMinutes') * 60;
    tx.ui.notify({
      title: wasWork ? 'Czas na przerwę' : 'Wracamy do pracy',
      body: wasWork ? `${tx.config.get('breakMinutes')} min przerwy.` : `${tx.config.get('workMinutes')} min skupienia.`,
      level: 'success',
    });
    if (!(wasWork && tx.config.get('autoStartBreak'))) toggle();
  };

  const toggle = () => {
    running = !running;
    clearInterval(timer);
    if (running) {
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) finish();
        draw();
      }, 1000);
    }
    draw();
  };

  const reset = () => {
    running = false;
    clearInterval(timer);
    phase = 'work';
    left = tx.config.get('workMinutes') * 60;
    draw();
  };

  item.onClick = toggle;
  tx.ui.commands.register('pomodoro.toggle', 'Pomodoro: start / pauza', toggle, { keybinding: 'Ctrl+Alt+P' });
  tx.ui.commands.register('pomodoro.reset', 'Pomodoro: reset', reset);
  tx.config.onChange((key) => { if (!running && key === 'workMinutes') reset(); });
  draw();
  item.show();
}

export function deactivate() {
  clearInterval(timer);
  item?.dispose();
}
