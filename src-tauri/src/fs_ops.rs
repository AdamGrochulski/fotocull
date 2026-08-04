use std::path::Path;
use serde::Serialize;

/// Status katalogu zwracany do frontendu po walidacji wyboru.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirStatus {
    /// Ścieżka istnieje na dysku.
    pub exists: bool,
    /// Ścieżka jest katalogiem (a nie plikiem).
    pub is_dir: bool,
    /// Katalog da się odczytać (listowanie zawartości).
    pub readable: bool,
    /// Do katalogu da się zapisać (test przez utworzenie i skasowanie pliku).
    pub writable: bool,
}

/// Sprawdź, czy do katalogu można zapisywać — realnym testem: utwórz plik
/// tymczasowy i skasuj. Pewniejsze cross-platform niż czytanie bitów uprawnień.
fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(".fotocull_write_test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Waliduj katalog wybrany przez użytkownika (źródłowy lub docelowy).
/// Nie modyfikuje niczego poza chwilowym plikiem-testem zapisu (od razu usuwanym).
#[tauri::command]
pub fn check_dir(path: String) -> DirStatus {
    let p = Path::new(&path);

    let exists = p.exists();
    let is_dir = p.is_dir();
    // Czytelność: próba wylistowania zawartości.
    let readable = is_dir && std::fs::read_dir(p).is_ok();
    // Zapisywalność testujemy tylko dla realnych katalogów.
    let writable = if is_dir { probe_writable(p) } else { false };

    DirStatus {
        exists,
        is_dir,
        readable,
        writable,
    }
}
