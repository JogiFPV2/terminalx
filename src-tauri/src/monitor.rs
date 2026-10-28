//! Monitoring tego komputera: CPU, RAM, dysk systemowy, sieć (liczniki narastające) i karta NVIDIA.
//! Hosty SSH frontend odpytuje jedną komendą przez `ssh_exec` (odczyt /proc), więc tu jest tylko część lokalna.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use sysinfo::{Disks, Networks};

#[derive(Default)]
pub struct MonState(Mutex<Option<(Disks, Networks)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    util: f32,
    mem_used: u64,
    mem_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    disk_used: u64,
    disk_total: u64,
    /// Bajty odebrane i wysłane od startu systemu (prędkość liczy frontend z różnicy).
    rx: u64,
    tx: u64,
    gpu: Option<Gpu>,
}

fn nvidia() -> Option<Gpu> {
    static HAS: OnceLock<bool> = OnceLock::new();
    let query = || crate::local::run_out("nvidia-smi", &["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
    if !*HAS.get_or_init(|| query().is_some()) {
        return None;
    }
    let out = query()?;
    let v: Vec<f64> = out.lines().next()?.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    (v.len() == 3).then(|| Gpu { util: v[0] as f32, mem_used: v[1] as u64 * 1024 * 1024, mem_total: v[2] as u64 * 1024 * 1024 })
}

#[tauri::command]
pub async fn mon_local(app: tauri::AppHandle) -> Result<Sample, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let (cpu, mem_used, mem_total) = {
            let sys = app.state::<crate::sys::SysState>();
            let mut s = sys.0.lock().unwrap();
            s.refresh_cpu_usage();
            s.refresh_memory();
            (s.global_cpu_usage(), s.used_memory(), s.total_memory())
        };
        let mon = app.state::<MonState>();
        let mut guard = mon.0.lock().unwrap();
        let (disks, nets) = guard.get_or_insert_with(|| (Disks::new_with_refreshed_list(), Networks::new_with_refreshed_list()));
        disks.refresh(true);
        nets.refresh(true);
        let sys_drive = std::env::var("SystemDrive").map(|d| format!("{d}\\")).unwrap_or_else(|_| "/".into());
        let disk = disks
            .list()
            .iter()
            .find(|d| d.mount_point().to_string_lossy().eq_ignore_ascii_case(&sys_drive))
            .or_else(|| disks.list().iter().max_by_key(|d| d.total_space()));
        let (disk_total, disk_used) = disk.map(|d| (d.total_space(), d.total_space() - d.available_space())).unwrap_or((0, 0));
        let (mut rx, mut tx) = (0, 0);
        for (name, n) in nets.list() {
            if name.to_lowercase().contains("loopback") || name == "lo" {
                continue;
            }
            rx += n.total_received();
            tx += n.total_transmitted();
        }
        drop(guard);
        Sample { cpu, mem_used, mem_total, disk_used, disk_total, rx, tx, gpu: nvidia() }
    })
    .await
    .map_err(|e| e.to_string())
}
