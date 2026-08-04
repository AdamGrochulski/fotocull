mod analyze;
mod copy;
mod exif;
mod fs_ops;
mod image;
mod manifest;
mod scan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Never keep a user folder as the process working directory. On Windows a
    // directory that is any process's CWD cannot be renamed or moved until that
    // process exits — which would silently lock the destination folder while the
    // app runs. Anchor to a neutral temp dir up front.
    let _ = std::env::set_current_dir(std::env::temp_dir());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            fs_ops::check_dir,
            fs_ops::open_folder,
            scan::scan_source,
            manifest::hash_jpg,
            manifest::renamed_targets,
            manifest::filter_by_manifest,
            image::read_image,
            image::read_thumbnail,
            copy::copy_accepted,
            analyze::analyze_image,
            exif::read_exif
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
