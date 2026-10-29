// Bez okna konsoli w buildzie release na Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hermitty_lib::run()
}
