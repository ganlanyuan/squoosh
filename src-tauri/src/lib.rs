use serde::Serialize;
use std::path::Path;
use tauri::ipc::Response;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "tif", "svg", "qoi", "jxl", "wp2",
];

#[derive(Serialize)]
struct ImageEntry {
    /// Absolute path on disk.
    path: String,
    /// File name including extension.
    name: String,
    /// Size in bytes.
    size: u64,
    /// Path relative to the selected folder (forward slashes), for preserving
    /// subfolder structure in the output.
    rel: String,
}

fn is_image(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

fn collect(
    root: &Path,
    dir: &Path,
    recursive: bool,
    out: &mut Vec<ImageEntry>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if recursive {
                collect(root, &path, recursive, out)?;
            }
        } else if file_type.is_file() && is_image(&path) {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let rel = path
                .strip_prefix(root)
                .ok()
                .and_then(|p| p.to_str())
                .unwrap_or(&name)
                .replace('\\', "/");
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ImageEntry {
                path: path.to_string_lossy().to_string(),
                name,
                size,
                rel,
            });
        }
    }
    Ok(())
}

/// List image files in a folder, optionally recursing into subfolders.
#[tauri::command]
fn list_images(dir: String, recursive: bool) -> Result<Vec<ImageEntry>, String> {
    let root = Path::new(&dir);
    let mut out = Vec::new();
    collect(root, root, recursive, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Read a file's raw bytes (returned efficiently as an ArrayBuffer to JS).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| e.to_string())
}

/// Write bytes to a path, creating parent directories as needed.
#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Whether a path already exists (used for collision handling).
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_images,
            read_file,
            write_file,
            path_exists
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
