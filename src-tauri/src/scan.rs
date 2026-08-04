use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// Jedno "zdjęcie" = para plików o wspólnej nazwie bazowej (stem).
/// JPG jest podglądem, ARW towarzyszem; każde z nich może brakować.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// Nazwa bazowa bez rozszerzenia, np. "DSC01234".
    pub base_name: String,
    /// Ścieżka do pliku JPG (jeśli jest).
    pub jpg_path: Option<String>,
    /// Ścieżka do pliku ARW (jeśli jest).
    pub arw_path: Option<String>,
    /// Katalog źródłowy pary (preferowany katalog JPG).
    pub source_dir: String,
}

/// Postęp skanu wysyłany do frontendu eventem `scan://progress`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    files_scanned: usize,
    images_found: usize,
}

/// Akumulator budowany podczas walk — przed złożeniem w `Photo`.
#[derive(Default)]
struct Entry {
    jpg_path: Option<String>,
    arw_path: Option<String>,
    jpg_dir: Option<String>,
    arw_dir: Option<String>,
}

fn parent_dir(p: &Path) -> String {
    p.parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Rekursywny skan katalogu źródłowego. Zbiera pliki .jpg/.jpeg/.arw
/// (case-insensitive), grupuje po nazwie bazowej. Tylko odczyt — nic nie zmienia.
/// Postęp raportuje eventami `scan://progress`.
#[tauri::command]
pub async fn scan_source(app: AppHandle, path: String) -> Result<Vec<Photo>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app, &path))
        .await
        .map_err(|e| format!("Zadanie skanu przerwane: {e}"))?
}

fn scan_blocking(app: &AppHandle, root: &str) -> Result<Vec<Photo>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("Folder źródłowy nie istnieje: {root}"));
    }

    // Klucz mapy: nazwa bazowa (stem) — parowanie niezależnie od katalogu.
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut files_scanned: usize = 0;

    for dent in WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !dent.file_type().is_file() {
            continue;
        }
        files_scanned += 1;

        let path = dent.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_ascii_lowercase(),
            None => continue,
        };

        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let full = path.to_string_lossy().to_string();
        let dir = parent_dir(path);

        match ext.as_str() {
            "jpg" | "jpeg" => {
                let e = entries.entry(stem).or_default();
                e.jpg_path = Some(full);
                e.jpg_dir = Some(dir);
            }
            "arw" => {
                let e = entries.entry(stem).or_default();
                e.arw_path = Some(full);
                e.arw_dir = Some(dir);
            }
            _ => {}
        }

        // Raport postępu co 200 przeskanowanych plików.
        if files_scanned % 200 == 0 {
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    files_scanned,
                    images_found: entries.len(),
                },
            );
        }
    }

    // Finalny event postępu (100%).
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            files_scanned,
            images_found: entries.len(),
        },
    );

    // Złóż wynik. source_dir: preferuj katalog JPG, w razie braku ARW.
    let mut photos: Vec<Photo> = entries
        .into_iter()
        .map(|(base_name, e)| Photo {
            base_name,
            jpg_path: e.jpg_path,
            arw_path: e.arw_path,
            source_dir: e.jpg_dir.or(e.arw_dir).unwrap_or_default(),
        })
        .collect();

    // Sortuj po nazwie bazowej — kolejność sekwencyjna z aparatu.
    photos.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(photos)
}
