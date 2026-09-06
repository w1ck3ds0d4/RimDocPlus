// Windows release builds should not open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rimdocplus_lib::run()
}
