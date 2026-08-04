use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Wpis manifestu: co i gdzie zostało skopiowane. Kluczem w mapie jest
/// SHA-256 pliku JPG (identyfikacja po treści, nie po nazwie).
/// Zapis wpisów następuje przy akceptacji (Etap 5); tutaj tylko odczyt.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub original_name: String,
    pub target_name: String,
    pub target_jpg_path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_arw_path: Option<String>,
    pub renamed: bool,
    pub date: String,
}

/// Zawartość `.fotocull/manifest.json`.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    /// hash JPG → wpis.
    #[serde(default)]
    pub entries: HashMap<String, ManifestEntry>,
}

/// Ścieżka do pliku manifestu w folderze docelowym.
pub fn manifest_path(dest_dir: &str) -> PathBuf {
    Path::new(dest_dir).join(".fotocull").join("manifest.json")
}

/// Wczytaj manifest z folderu docelowego. Brak pliku = pusty manifest
/// (nic nie tworzymy na dysku aż do pierwszego zapisu w Etapie 5).
pub fn load_manifest(dest_dir: &str) -> Result<Manifest, String> {
    let path = manifest_path(dest_dir);
    if !path.exists() {
        return Ok(Manifest::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Nie można odczytać manifestu: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Uszkodzony manifest: {e}"))
}

/// SHA-256 zawartości pliku (hex). Czyta strumieniowo — bezpieczne dla dużych JPG.
pub fn hash_file(path: &str) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Nie można otworzyć {path}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Błąd odczytu {path}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Komenda: SHA-256 pojedynczego pliku JPG.
#[tauri::command]
pub fn hash_jpg(path: String) -> Result<String, String> {
    hash_file(&path)
}

/// Wynik dopasowania jednego JPG do manifestu.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HashResult {
    pub path: String,
    pub hash: String,
    /// Hash już w manifeście → zdjęcie było wcześniej skopiowane.
    pub already_copied: bool,
}

/// Postęp hashowania (event `hash://progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HashProgress {
    hashed: usize,
    total: usize,
}

/// Zhashuj podane pliki JPG i oznacz, które są już w manifeście folderu
/// docelowego. Frontend na tej podstawie odfiltrowuje zdjęcia już przeniesione.
#[tauri::command]
pub async fn filter_by_manifest(
    app: AppHandle,
    dest_dir: String,
    jpg_paths: Vec<String>,
) -> Result<Vec<HashResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = load_manifest(&dest_dir)?;
        let total = jpg_paths.len();
        let mut out = Vec::with_capacity(total);

        for (i, path) in jpg_paths.into_iter().enumerate() {
            let hash = hash_file(&path)?;
            let already_copied = manifest.entries.contains_key(&hash);
            out.push(HashResult {
                path,
                hash,
                already_copied,
            });

            if (i + 1) % 20 == 0 || i + 1 == total {
                let _ = app.emit(
                    "hash://progress",
                    HashProgress {
                        hashed: i + 1,
                        total,
                    },
                );
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Zadanie hashowania przerwane: {e}"))?
}
