// Wersja na komputer służy tylko do podglądu interfejsu podczas pracy (npm run mobile:dev w przeglądarce wystarcza).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hermitty_mobile_lib::run()
}
