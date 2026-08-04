mod analyze;
mod copy;
mod fs_ops;
mod image;
mod manifest;
mod scan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            fs_ops::check_dir,
            fs_ops::open_folder,
            scan::scan_source,
            manifest::hash_jpg,
            manifest::filter_by_manifest,
            image::read_image,
            copy::copy_accepted,
            analyze::analyze_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
