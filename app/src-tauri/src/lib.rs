use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use std::fs;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri_winrt_notification::{Duration as ToastDuration, Toast};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::client_async_tls_with_config;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

static LOCKED: AtomicBool = AtomicBool::new(false);
static SUBTITLE_ALWAYS_ON_TOP: AtomicBool = AtomicBool::new(true);
static SUBTITLE_BG_ACTIVE: AtomicBool = AtomicBool::new(false);
static SUBTITLE_HIT_AREAS: Mutex<Vec<SubtitleHitArea>> = Mutex::new(Vec::new());
static LOCK_BUTTON_RECT: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 0.0, 0.0));
struct GeminiConnectionState {
    generation: u64,
    sender: Option<mpsc::UnboundedSender<String>>,
}

impl GeminiConnectionState {
    fn begin(&mut self, sender: mpsc::UnboundedSender<String>) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.sender = Some(sender);
        self.generation
    }

    fn disconnect(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.sender = None;
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation == generation && self.sender.is_some()
    }

    fn finish(&mut self, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        self.sender = None;
        true
    }
}

static GEMINI_CONNECTION: Mutex<GeminiConnectionState> = Mutex::new(GeminiConnectionState {
    generation: 0,
    sender: None,
});
static LLM_REQUESTS: LazyLock<Mutex<HashMap<String, Arc<LlmRequestControl>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

trait ProxyStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProxyStream for T {}

#[derive(Clone, Copy, serde::Deserialize)]
struct SubtitleHitArea {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[repr(C)]
struct POINT { x: i32, y: i32 }

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(lpPoint: *mut POINT) -> i32;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

const VK_LBUTTON: i32 = 0x01;

static CAPTURING: AtomicBool = AtomicBool::new(false);
const SESSION_ARCHIVE_FILE: &str = "sessions.json";
const SUMMARY_ITEMS_FILE: &str = "summary.json";
const MAX_SESSION_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;

fn session_archive_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(SESSION_ARCHIVE_FILE))
}

fn summary_items_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(SUMMARY_ITEMS_FILE))
}

fn read_json_file(path: PathBuf, empty: &str) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json_file(_app: &tauri::AppHandle, path: PathBuf, contents: String) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    if !value.is_object() && !value.is_array() {
        return Err("JSON 格式无效".to_string());
    }
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, contents).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(temporary_path, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_archive(app: tauri::AppHandle) -> Result<String, String> {
    read_json_file(session_archive_path(&app)?, "{\"version\":1,\"sessions\":[]}")
}

#[tauri::command]
fn save_session_archive(app: tauri::AppHandle, archive: String) -> Result<(), String> {
    if archive.len() > MAX_SESSION_ARCHIVE_BYTES {
        return Err("Session 归档超过 64 MB 限制".to_string());
    }
    write_json_file(&app, session_archive_path(&app)?, archive)
}

#[tauri::command]
fn load_summary_items(app: tauri::AppHandle) -> Result<String, String> {
    read_json_file(summary_items_path(&app)?, "[]")
}

#[tauri::command]
fn save_summary_items(app: tauri::AppHandle, items: String) -> Result<(), String> {
    if items.len() > MAX_SESSION_ARCHIVE_BYTES {
        return Err("总结历史超过 64 MB 限制".to_string());
    }
    write_json_file(&app, summary_items_path(&app)?, items)
}

#[tauri::command]
async fn gemini_connect(app: tauri::AppHandle, url: String, proxy_url: Option<String>) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let generation = GEMINI_CONNECTION
        .lock()
        .map_err(|_| "Gemini connection lock failed".to_string())?
        .begin(tx);

    tauri::async_runtime::spawn(async move {
        let result = async {
            if !gemini_connection_is_current(generation) {
                return Ok::<(), String>(());
            }
            emit_gemini_event(&app, generation, "gemini-log", "正在创建网络连接")?;
            let stream = connect_proxy_stream(&url, proxy_url.as_deref()).await?;
            if !gemini_connection_is_current(generation) {
                return Ok(());
            }
            emit_gemini_event(&app, generation, "gemini-log", "网络连接已建立，正在进行 WebSocket 握手")?;
            let (ws, _) = client_async_tls_with_config(url.as_str(), stream, None, None)
                .await
                .map_err(|e| e.to_string())?;
            if !gemini_connection_is_current(generation) {
                return Ok(());
            }
            let (mut write, mut read) = ws.split();
            emit_gemini_event(&app, generation, "gemini-open", ())?;

            loop {
                tokio::select! {
                    outgoing = rx.recv() => {
                        match outgoing {
                            Some(text) => write.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
                            None => break,
                        }
                    }
                    incoming = read.next() => {
                        if !gemini_connection_is_current(generation) {
                            break;
                        }
                        match incoming {
                            Some(Ok(Message::Text(text))) => emit_gemini_event(&app, generation, "gemini-message", text.to_string())?,
                            Some(Ok(Message::Binary(data))) => emit_gemini_event(&app, generation, "gemini-message", String::from_utf8_lossy(&data).to_string())?,
                            Some(Ok(Message::Close(frame))) => {
                                let reason = frame
                                    .map(|v| format!("WebSocket 被关闭：{} {}", v.code, v.reason))
                                    .unwrap_or_else(|| "WebSocket 被关闭".to_string());
                                emit_gemini_event(&app, generation, "gemini-log", reason)?;
                                break;
                            }
                            None => {
                                emit_gemini_event(&app, generation, "gemini-log", "WebSocket 数据流结束")?;
                                break;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => return Err(e.to_string()),
                        }
                    }
                }
            }
            Ok::<(), String>(())
        }.await;

        finish_gemini_connection(&app, generation, result);
    });

    Ok(())
}

#[tauri::command]
fn gemini_send(message: String) -> Result<(), String> {
    let tx = GEMINI_CONNECTION
        .lock()
        .map_err(|_| "Gemini connection lock failed".to_string())?
        .sender
        .clone()
        .ok_or("Gemini is not connected")?;
    tx.send(message).map_err(|_| "Gemini connection is closed".to_string())
}

#[tauri::command]
fn gemini_disconnect() {
    if let Ok(mut state) = GEMINI_CONNECTION.lock() {
        state.disconnect();
    }
}

fn gemini_connection_is_current(generation: u64) -> bool {
    GEMINI_CONNECTION
        .lock()
        .map(|state| state.is_current(generation))
        .unwrap_or(false)
}

fn finish_gemini_connection(app: &tauri::AppHandle, generation: u64, result: Result<(), String>) {
    let Ok(mut state) = GEMINI_CONNECTION.lock() else {
        return;
    };
    if !state.finish(generation) {
        return;
    }
    if let Err(error) = result {
        let _ = app.emit("gemini-error", error);
    }
    let _ = app.emit("gemini-close", ());
}

fn emit_gemini_event<S: serde::Serialize + Clone>(
    app: &tauri::AppHandle,
    generation: u64,
    event: &str,
    payload: S,
) -> Result<(), String> {
    let state = GEMINI_CONNECTION
        .lock()
        .map_err(|_| "Gemini connection lock failed".to_string())?;
    if state.generation != generation {
        return Ok(());
    }
    app.emit(event, payload).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct GenerateTextResponse {
    status: u16,
    body: String,
}

#[tauri::command]
async fn gemini_generate_text(url: String, proxy_url: Option<String>, headers: Vec<(String, String)>, body: String) -> Result<GenerateTextResponse, String> {
    let mut current = url;
    for _ in 0..5 {
        let (status, text, location) = send_http_json_request(&current, proxy_url.as_deref(), &headers, &body).await?;
        if (300..400).contains(&status) {
            if let Some(location) = location {
                if let Ok(base) = Url::parse(&current) {
                    if let Ok(next) = base.join(&location) {
                        current = next.to_string();
                        continue;
                    }
                }
            }
        }
        return Ok(GenerateTextResponse { status, body: text });
    }
    Err("重定向次数过多".to_string())
}

async fn send_http_json_request(url: &str, proxy_url: Option<&str>, headers: &[(String, String)], body: &str) -> Result<(u16, String, Option<String>), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    let host = target.host_str().ok_or("Base URL 缺少主机名")?.to_string();

    tokio::time::timeout(Duration::from_secs(90), async {
        let mut stream = connect_proxy_stream(url, proxy_url).await?;
        if target.scheme() == "https" {
            let connector = native_tls::TlsConnector::builder()
                .build()
                .map_err(|e| e.to_string())?;
            stream = Box::new(
                tokio_native_tls::TlsConnector::from(connector)
                    .connect(&host, stream)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }

        let path = match target.query() {
            Some(query) => format!("{}?{}", target.path(), query),
            None => target.path().to_string(),
        };
        let header_lines = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}"))
            .collect::<Vec<_>>()
            .join("\r\n");
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n{header_lines}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.map_err(|e| e.to_string())?;
        let header_end = find_bytes(&raw, b"\r\n\r\n").ok_or("HTTP 响应格式无效")?;
        let head = &raw[..header_end];
        let raw_body = &raw[header_end + 4..];
        let head_text = String::from_utf8_lossy(head);
        let status = head_text
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("0")
            .parse::<u16>()
            .unwrap_or(0);
        let location = head_text
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("location:"))
            .and_then(|line| line.split_once(':').map(|(_, value)| value.trim().to_string()));
        let text = if head_text.to_lowercase().contains("transfer-encoding: chunked") {
            String::from_utf8_lossy(&decode_chunked(raw_body)).into_owned()
        } else {
            String::from_utf8_lossy(raw_body).into_owned()
        };
        Ok::<_, String>((status, text, location))
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

const LLM_STREAM_READ_TIMEOUT_SECS: u64 = 300;
const LLM_STREAM_CONNECT_TIMEOUT_SECS: u64 = 30;
const LLM_ERROR_BODY_TIMEOUT_SECS: u64 = 5;
const LLM_STREAM_MAX_BODY_BYTES: usize = 64 * 1024;

struct LlmRequestControl {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl LlmRequestControl {
    fn new() -> Self {
        Self { cancelled: AtomicBool::new(false), notify: tokio::sync::Notify::new() }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
}

#[derive(Clone, serde::Serialize)]
struct LlmChunkPayload {
    request_id: String,
    text: String,
}

#[tauri::command]
async fn gemini_generate_text_stream(
    app: tauri::AppHandle,
    request_id: String,
    url: String,
    proxy_url: Option<String>,
    headers: Vec<(String, String)>,
    body: String,
) -> Result<String, String> {
    let control = Arc::new(LlmRequestControl::new());
    if let Ok(mut requests) = LLM_REQUESTS.lock() {
        requests.insert(request_id.clone(), control.clone());
    }
    let chunk_event = format!("gemini-llm-chunk-{request_id}");
    let result = stream_llm_response(&app, &chunk_event, &url, proxy_url.as_deref(), &headers, &body, &request_id, control).await;
    if let Ok(mut requests) = LLM_REQUESTS.lock() {
        requests.remove(&request_id);
    }
    if let Err(error) = &result {
        emit_llm_log(&app, &format!("AI 流式请求结束（失败）：{}", error));
    }
    result
}

#[tauri::command]
fn gemini_cancel_text_stream(request_id: String) -> Result<(), String> {
    let control = LLM_REQUESTS
        .lock()
        .map_err(|_| "AI 请求状态锁定失败".to_string())?
        .get(&request_id)
        .cloned();
    if let Some(control) = control {
        control.cancel();
    }
    Ok(())
}

async fn stream_llm_response(
    app: &tauri::AppHandle,
    chunk_event: &str,
    url: &str,
    proxy_url: Option<&str>,
    headers: &[(String, String)],
    body: &str,
    request_id: &str,
    control: Arc<LlmRequestControl>,
) -> Result<String, String> {
    emit_llm_log(app, &format!("AI 流式请求连接中：{}", mask_llm_url(url)));
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    let host = target.host_str().ok_or("Base URL 缺少主机名")?.to_string();
    let mut stream = wait_with_control(
        &control,
        tokio::time::timeout(Duration::from_secs(LLM_STREAM_CONNECT_TIMEOUT_SECS), connect_proxy_stream(url, proxy_url)),
    )
    .await
    .map_err(|_| "请求已取消".to_string())?
    .map_err(|_| "连接模型服务超时".to_string())?
    .map_err(|e| e.to_string())?;
    emit_llm_log(app, "AI 流式请求网络连接已建立");
    if target.scheme() == "https" {
        emit_llm_log(app, "AI 流式请求正在进行 TLS 握手");
        let connector = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| e.to_string())?;
        let tls_stream = wait_with_control(
            &control,
            tokio::time::timeout(
                Duration::from_secs(LLM_STREAM_CONNECT_TIMEOUT_SECS),
                tokio_native_tls::TlsConnector::from(connector).connect(&host, stream),
            ),
        )
        .await
        .map_err(|_| "请求已取消".to_string())?
        .map_err(|_| "TLS 握手超时".to_string())?
        .map_err(|e| e.to_string())?;
        stream = Box::new(tls_stream);
        emit_llm_log(app, "AI 流式请求 TLS 握手完成");
    }

    let path = match target.query() {
        Some(query) => format!("{}?{}", target.path(), query),
        None => target.path().to_string(),
    };
    let header_lines = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\r\n");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n{header_lines}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    wait_with_control(
        &control,
        tokio::time::timeout(Duration::from_secs(LLM_STREAM_CONNECT_TIMEOUT_SECS), async {
            stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
            stream.flush().await.map_err(|e| e.to_string())?;
            Ok::<_, String>(())
        }),
    )
    .await
    .map_err(|_| "请求已取消".to_string())?
    .map_err(|_| "发送请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    emit_llm_log(app, "AI 流式请求已发送，等待响应头");

    let (head_bytes, extra) = read_until_header_end(&mut stream, &control).await?;
    let head_text = String::from_utf8_lossy(&head_bytes);
    let status = head_text
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse::<u16>()
        .unwrap_or(0);
    emit_llm_log(app, &format!("AI 流式请求收到响应头：HTTP {status}"));
    if !(200..300).contains(&status) {
        let mut rest = extra;
        rest.extend(read_remaining(&mut stream, LLM_STREAM_MAX_BODY_BYTES, &control, LLM_ERROR_BODY_TIMEOUT_SECS).await.unwrap_or_default());
        let preview = String::from_utf8_lossy(&rest).replace(['\n', '\r'], " ").chars().take(200).collect::<String>();
        return Err(format!("HTTP {status}：{}", if preview.is_empty() { "(空)" } else { preview.as_str() }));
    }

    let chunked = head_text.to_lowercase().contains("transfer-encoding: chunked");
    let mut decoder = ChunkedDecoder::new();
    let mut lines = LineBuffer::new();
    let mut sse = SseParser::new();
    let mut pending: Vec<u8> = extra;
    let mut chunk = [0u8; 16384];
    let mut text = String::new();
    let mut emitted_first_chunk = false;
    loop {
        let decoded = if pending.is_empty() {
            let n = wait_with_control(
                &control,
                tokio::time::timeout(Duration::from_secs(LLM_STREAM_READ_TIMEOUT_SECS), stream.read(&mut chunk)),
            )
            .await
            .map_err(|_| "请求已取消".to_string())?
            .map_err(|_| "等待模型响应超过 300 秒".to_string())?
            .map_err(|e| e.to_string())?;
            if n == 0 { break; }
            if chunked { decoder.push(&chunk[..n]) } else { chunk[..n].to_vec() }
        } else {
            let first = std::mem::take(&mut pending);
            if chunked { decoder.push(&first) } else { first }
        };
        let mut parsed = Vec::new();
        lines.push(&decoded, &mut parsed);
        for line in parsed {
            let (piece, parse_error) = sse.push_line(&line);
            if let Some(message) = parse_error {
                emit_llm_log(app, &message);
            }
            if let Some(piece) = piece {
                text.push_str(&piece);
                if !emitted_first_chunk {
                    emitted_first_chunk = true;
                    emit_llm_log(app, "AI 流式请求收到首个文本块");
                }
                app.emit(chunk_event, LlmChunkPayload { request_id: request_id.to_string(), text: piece })
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let mut parsed = Vec::new();
    lines.finish(&mut parsed);
    for line in parsed {
        let (piece, parse_error) = sse.push_line(&line);
        if let Some(message) = parse_error {
            emit_llm_log(app, &message);
        }
        if let Some(piece) = piece {
            text.push_str(&piece);
            app.emit(chunk_event, LlmChunkPayload { request_id: request_id.to_string(), text: piece })
                .map_err(|e| e.to_string())?;
        }
    }
    let (piece, parse_error) = sse.finish();
    if let Some(message) = parse_error {
        emit_llm_log(app, &message);
    }
    if let Some(piece) = piece {
        text.push_str(&piece);
        app.emit(chunk_event, LlmChunkPayload { request_id: request_id.to_string(), text: piece })
            .map_err(|e| e.to_string())?;
    }
    if text.trim().is_empty() {
        return Err("模型没有返回文本".to_string());
    }
    emit_llm_log(app, &format!("AI 流式请求结束，收到 {} 个字符", text.chars().count()));
    Ok(text)
}

async fn read_until_header_end(stream: &mut Box<dyn ProxyStream>, control: &Arc<LlmRequestControl>) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = wait_with_control(
            control,
            tokio::time::timeout(Duration::from_secs(LLM_STREAM_READ_TIMEOUT_SECS), stream.read(&mut chunk)),
        )
        .await
        .map_err(|_| "请求已取消".to_string())?
        .map_err(|_| "等待响应头超过 300 秒".to_string())?
        .map_err(|e| e.to_string())?;
        if n == 0 { return Err("HTTP 响应不完整".to_string()); }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") {
            let extra = buf.split_off(pos + 4);
            return Ok((buf, extra));
        }
    }
}

async fn read_remaining(
    stream: &mut Box<dyn ProxyStream>,
    max: usize,
    control: &Arc<LlmRequestControl>,
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = wait_with_control(
            control,
            tokio::time::timeout(Duration::from_secs(timeout_secs), stream.read(&mut chunk)),
        )
            .await
            .map_err(|_| "请求已取消".to_string())?
            .map_err(|_| "读取响应超时".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 || buf.len() >= max { break; }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

async fn wait_with_control<F>(control: &Arc<LlmRequestControl>, future: F) -> Result<F::Output, ()>
where
    F: Future,
{
    if control.cancelled.load(Ordering::Acquire) {
        return Err(());
    }
    tokio::select! {
        result = future => Ok(result),
        _ = control.notify.notified() => Err(()),
    }
}

struct ChunkedDecoder {
    pending: Vec<u8>,
    chunk_remaining: usize,
    in_chunk: bool,
    out: Vec<u8>,
}

impl ChunkedDecoder {
    fn new() -> Self {
        Self { pending: Vec::new(), chunk_remaining: 0, in_chunk: false, out: Vec::new() }
    }

    fn push(&mut self, data: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(data);
        loop {
            if !self.in_chunk {
                match find_bytes(&self.pending, b"\r\n") {
                    Some(pos) => {
                        let size = usize::from_str_radix(
                            std::str::from_utf8(&self.pending[..pos])
                                .unwrap_or("0")
                                .split(';')
                                .next()
                                .unwrap_or("0")
                                .trim(),
                            16,
                        )
                        .unwrap_or(0);
                        self.pending.drain(..pos + 2);
                        self.chunk_remaining = size;
                        self.in_chunk = true;
                    }
                    None => break,
                }
            } else if self.chunk_remaining == 0 {
                if self.pending.len() >= 2 {
                    self.pending.drain(..2);
                    self.in_chunk = false;
                } else {
                    break;
                }
            } else {
                let take = self.pending.len().min(self.chunk_remaining);
                if take == 0 { break; }
                self.out.extend_from_slice(&self.pending[..take]);
                self.pending.drain(..take);
                self.chunk_remaining -= take;
            }
        }
        std::mem::take(&mut self.out)
    }
}

struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn push(&mut self, data: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(data);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&self.buf[..pos]).into_owned();
            self.buf.drain(..pos + 1);
            out.push(line);
        }
    }

    fn finish(&mut self, out: &mut Vec<String>) {
        if !self.buf.is_empty() {
            out.push(String::from_utf8_lossy(&self.buf).into_owned());
            self.buf.clear();
        }
    }
}

// 按 SSE 规范聚合事件：连续的 data: 行属于同一个事件，payload 以换行连接，空行触发解析。
// 返回 (提取的文本, 解析失败日志)。
struct SseParser {
    event_lines: Vec<String>,
}

impl SseParser {
    fn new() -> Self {
        Self { event_lines: Vec::new() }
    }

    fn push_line(&mut self, line: &str) -> (Option<String>, Option<String>) {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            return self.flush_event();
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            let payload = rest.trim();
            if !payload.is_empty() && payload != "[DONE]" {
                self.event_lines.push(payload.to_string());
                // 无空行分隔的非标准流：累积过多时强制解析，避免堆到流结束才处理。
                if self.event_lines.len() >= 32 {
                    return self.flush_event();
                }
            }
            return (None, None);
        }
        if trimmed.starts_with(':') || trimmed.starts_with("event:") || trimmed.starts_with("id:") || trimmed.starts_with("retry:") {
            return (None, None);
        }
        // 兼容非 SSE 的逐行 JSON 流。
        match extract_stream_text(trimmed) {
            Some(text) => (Some(text), None),
            None => {
                if serde_json::from_str::<serde_json::Value>(trimmed).is_err() {
                    (None, Some(format!("AI 流式行解析失败：{}", compact_preview(trimmed))))
                } else {
                    // 合法 JSON 但无文本（角色宣告、空 content、结束标记等），属正常事件。
                    (None, None)
                }
            }
        }
    }

    fn flush_event(&mut self) -> (Option<String>, Option<String>) {
        if self.event_lines.is_empty() {
            return (None, None);
        }
        let payload = self.event_lines.join("\n");
        self.event_lines.clear();
        match extract_stream_text(&payload) {
            Some(text) => (Some(text), None),
            None => {
                if serde_json::from_str::<serde_json::Value>(&payload).is_err() {
                    (None, Some(format!("AI 流式 chunk 解析失败：{}", compact_preview(&payload))))
                } else {
                    (None, None)
                }
            }
        }
    }

    fn finish(&mut self) -> (Option<String>, Option<String>) {
        self.flush_event()
    }
}

fn compact_preview(text: &str) -> String {
    text.replace(['\n', '\r'], " ").chars().take(200).collect()
}

#[cfg(test)]
fn sse_data_payload(line: &str) -> Option<String> {
    let rest = line.trim_end_matches('\r').strip_prefix("data:")?.trim();
    if rest.is_empty() || rest == "[DONE]" { None } else { Some(rest.to_string()) }
}

fn extract_stream_text(payload: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    if let Some(text) = value.pointer("/candidates/0/content/parts/0/text").and_then(|v| v.as_str()) {
        if !text.is_empty() { return Some(text.to_string()); }
    }
    if let Some(text) = value.pointer("/choices/0/delta/content").and_then(|v| v.as_str()) {
        if !text.is_empty() { return Some(text.to_string()); }
    }
    None
}

fn emit_llm_log(app: &tauri::AppHandle, message: &str) {
    let _ = app.emit("gemini-log", message.to_string());
}

fn mask_llm_url(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut value) => {
            if value.query_pairs().any(|(key, _)| key == "key") {
                let pairs = value
                    .query_pairs()
                    .map(|(key, value)| {
                        let key = key.into_owned();
                        let value = if key == "key" { "***".to_string() } else { value.into_owned() };
                        (key, value)
                    })
                    .collect::<Vec<_>>();
                value.set_query(None);
                let query = pairs
                    .iter()
                    .map(|(key, value)| format!("{}={}", key, value))
                    .collect::<Vec<_>>()
                    .join("&");
                value.set_query(Some(&query));
            }
            value.to_string()
        }
        Err(_) => url.to_string(),
    }
}

fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut rest = body;
    while let Some(header_end) = find_bytes(rest, b"\r\n") {
        let size_line = &rest[..header_end];
        let size_text = size_line.split(|&b| b == b';').next().unwrap_or(&[]);
        let size = usize::from_str_radix(std::str::from_utf8(size_text).unwrap_or("0").trim(), 16).unwrap_or(0);
        rest = &rest[header_end + 2..];
        if size == 0 { break; }
        if rest.len() < size + 2 { break; }
        output.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_gemini_connection_cannot_finish_current_connection() {
        let (first_sender, _) = mpsc::unbounded_channel();
        let (second_sender, _) = mpsc::unbounded_channel();
        let mut state = GeminiConnectionState { generation: 0, sender: None };

        let first_generation = state.begin(first_sender);
        let second_generation = state.begin(second_sender);

        assert!(!state.finish(first_generation));
        assert!(state.is_current(second_generation));
        assert!(state.finish(second_generation));
        assert!(state.sender.is_none());
    }

    #[test]
    fn gemini_disconnect_invalidates_running_connection() {
        let (sender, _) = mpsc::unbounded_channel();
        let mut state = GeminiConnectionState { generation: 0, sender: None };
        let generation = state.begin(sender);

        state.disconnect();

        assert!(!state.is_current(generation));
        assert!(!state.finish(generation));
    }

    #[test]
    fn decodes_simple_chunked_body() {
        let body = b"5\r\nHello\r\n6\r\n World\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), b"Hello World");
    }

    #[test]
    fn decodes_chunked_with_extensions_and_multibyte_utf8() {
        // "中文" is 6 bytes in UTF-8; a chunk boundary may split it.
        let body = b"3\r\n\xe4\xb8\xad\r\n3\r\n\xe6\x96\x87\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), "中文".as_bytes());
    }

    #[test]
    fn finds_bytes_subsequence() {
        assert_eq!(find_bytes(b"abc\r\n\r\ndef", b"\r\n\r\n"), Some(3));
        assert_eq!(find_bytes(b"abc", b"\r\n"), None);
    }

    #[test]
    fn chunked_decoder_handles_split_chunks() {
        let mut decoder = ChunkedDecoder::new();
        let first = decoder.push(b"5\r\nHel");
        let second = decoder.push(b"lo\r\n6\r\n World\r\n0\r\n\r\n");
        let combined: Vec<u8> = first.into_iter().chain(second).collect();
        assert_eq!(combined, b"Hello World");
    }

    #[test]
    fn sse_parser_extracts_data_payloads() {
        assert_eq!(sse_data_payload("data: {\"a\":1}\r"), Some("{\"a\":1}".to_string()));
        assert_eq!(sse_data_payload("data: [DONE]"), None);
        assert_eq!(sse_data_payload("event: message"), None);
    }

    #[test]
    fn sse_parser_joins_multiline_data_events() {
        // 聚合站把单个 JSON 拆成多行 data: 行（拆在语法空白处），事件以空行结束。
        let mut sse = SseParser::new();
        let mut pieces = Vec::new();
        pieces.extend(sse.push_line(r##"data: {"choices":[{"delta":{"content":"##).0);
        pieces.extend(sse.push_line(r#"data: "[{\"original\":\"a\",\"translation\":\"甲\"},{\"original\":\"b\",\"translation\":\"乙\"}]"}}]}"#).0);
        pieces.extend(sse.push_line("").0);
        pieces.extend(sse.push_line("data: [DONE]").0);
        pieces.extend(sse.push_line("").0);
        assert_eq!(pieces, vec![r#"[{"original":"a","translation":"甲"},{"original":"b","translation":"乙"}]"#]);
        assert!(sse.finish().0.is_none());
    }

    #[test]
    fn sse_parser_flushes_after_event_boundary() {
        let mut sse = SseParser::new();
        assert_eq!(
            sse.push_line(r#"data: {"choices":[{"delta":{"content":" hi "}}]}"#).0,
            None
        );
        assert_eq!(sse.push_line("").0, Some(" hi ".to_string()));
    }

    #[test]
    fn sse_parser_ignores_comment_and_field_lines() {
        let mut sse = SseParser::new();
        assert_eq!(sse.push_line(": keep-alive").0, None);
        assert_eq!(sse.push_line("event: message").0, None);
        assert_eq!(sse.push_line("id: 1").0, None);
        assert_eq!(sse.push_line("retry: 3000").0, None);
        assert!(sse.finish().0.is_none());
    }

    #[test]
    fn extracts_gemini_and_openai_stream_text() {
        assert_eq!(
            extract_stream_text(r#"{"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}"#),
            Some("你好".to_string())
        );
        assert_eq!(
            extract_stream_text(r#"{"choices":[{"delta":{"content":" world"}}]}"#),
            Some(" world".to_string())
        );
        assert_eq!(extract_stream_text(r#"{"foo":"bar"}"#), None);
    }

    #[test]
    fn sse_parser_ignores_empty_content_chunks() {
        // OpenAI 流的角色宣告与结束标记块 content 为空，不应报解析失败。
        let mut sse = SseParser::new();
        assert_eq!(
            sse.push_line(r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#),
            (None, None)
        );
        assert_eq!(sse.push_line(""), (None, None));
        assert_eq!(
            sse.push_line(r#"data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}"#),
            (None, None)
        );
        assert_eq!(sse.push_line(""), (None, None));
        assert_eq!(sse.finish(), (None, None));
    }

    #[test]
    fn sse_parser_reports_invalid_json() {
        let mut sse = SseParser::new();
        assert_eq!(sse.push_line("data: {broken json"), (None, None));
        let (text, error) = sse.push_line("");
        assert_eq!(text, None);
        assert!(error.unwrap().contains("解析失败"));
    }

    #[test]
    fn line_buffer_splits_partial_lines() {
        let mut buffer = LineBuffer::new();
        let mut lines = Vec::new();
        buffer.push(b"data: a\ndata: b\r", &mut lines);
        assert_eq!(lines, vec!["data: a"]);
        buffer.push(b"\ndata: c\n", &mut lines);
        assert_eq!(lines, vec!["data: a", "data: b\r", "data: c"]);
        buffer.finish(&mut lines);
        assert_eq!(lines, vec!["data: a", "data: b\r", "data: c"]);
    }
}

async fn connect_proxy_stream(url: &str, proxy_url: Option<&str>) -> Result<Box<dyn ProxyStream>, String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    let host = target.host_str().ok_or("Base URL 缺少主机名")?.to_string();
    let port = target.port_or_known_default().ok_or("Base URL 缺少端口")?;

    let Some(proxy_url) = proxy_url.map(str::trim).filter(|v| !v.is_empty()) else {
        let stream = TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        return Ok(Box::new(stream));
    };

    let proxy = Url::parse(proxy_url).map_err(|e| format!("代理地址无效：{}", e))?;
    let proxy_host = proxy.host_str().ok_or("代理地址缺少主机名")?.to_string();
    let proxy_port = proxy.port_or_known_default().ok_or("代理地址缺少端口")?;

    match proxy.scheme() {
        "socks5" | "socks5h" => {
            let stream = tokio_socks::tcp::Socks5Stream::connect((proxy_host.as_str(), proxy_port), (host.as_str(), port))
                .await
                .map_err(|e| e.to_string())?;
            Ok(Box::new(stream))
        }
        "http" | "https" => {
            let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port)).await.map_err(|e| e.to_string())?;
            let request = format!(
                "CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\nProxy-Connection: Keep-Alive\r\n\r\n",
                host, port, host, port
            );
            stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
            let mut buf = Vec::with_capacity(1024);
            let mut tmp = [0u8; 1];
            while !buf.ends_with(b"\r\n\r\n") && buf.len() < 8192 {
                let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
                if n == 0 { break; }
                buf.push(tmp[0]);
            }
            let response = String::from_utf8_lossy(&buf);
            if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
                return Err("HTTP 代理连接失败".to_string());
            }
            Ok(Box::new(stream))
        }
        _ => Err("代理只支持 http、https、socks5 或 socks5h".to_string()),
    }
}

#[derive(serde::Serialize)]
struct AudioDevice {
    id: String,
    name: String,
    kind: String,
}

#[tauri::command]
fn get_audio_devices() -> (Vec<AudioDevice>, String) {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();
    let mut devices = Vec::new();
    if let Ok(output_devices) = host.output_devices() {
        for (index, device) in output_devices.enumerate() {
            if let Ok(name) = device.name() {
                devices.push(AudioDevice {
                    id: format!("output:{}", index),
                    name,
                    kind: "output".to_string(),
                });
            }
        }
    }
    if let Ok(input_devices) = host.input_devices() {
        for (index, device) in input_devices.enumerate() {
            if let Ok(name) = device.name() {
                devices.push(AudioDevice {
                    id: format!("input:{}", index),
                    name,
                    kind: "input".to_string(),
                });
            }
        }
    }
    let default_id = devices
        .iter()
        .find(|device| device.kind == "output" && device.name == default_name)
        .map(|device| device.id.clone())
        .unwrap_or_default();
    (devices, default_id)
}

#[tauri::command]
fn start_capture(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    if CAPTURING.load(Ordering::SeqCst) {
        return Ok(());
    }

    let host = cpal::default_host();
    let (device_kind, index_text) = device_id
        .split_once(':')
        .ok_or("Invalid audio device selection")?;
    let index = index_text
        .parse::<usize>()
        .map_err(|_| "Invalid audio device selection".to_string())?;
    let device = match device_kind {
        "input" => host
            .input_devices()
            .map_err(|e| format!("Cannot enumerate input devices: {}", e))?
            .nth(index)
            .ok_or("Selected input device was not found")?,
        "output" => host
            .output_devices()
            .map_err(|e| format!("Cannot enumerate output devices: {}", e))?
            .nth(index)
            .ok_or("Selected output device was not found")?,
        _ => return Err("Invalid audio device selection".to_string()),
    };

    let config = if device_kind == "input" {
        device.default_input_config()
    } else {
        device.default_output_config()
    }
        .map_err(|e| format!("Cannot get audio config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();

    println!("[Audio] Capturing: {}Hz, {}ch, {:?}", sample_rate, channels, sample_format);

    CAPTURING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let err_fn = |err: cpal::StreamError| eprintln!("[Audio] Stream error: {}", err);

        let result = match sample_format {
            cpal::SampleFormat::F32 => {
                let cfg: cpal::StreamConfig = config.into();
                let app_clone = app.clone();
                device.build_input_stream(
                    &cfg,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mono = to_mono_f32(data, channels);
                        let resampled = resample(&mono, sample_rate as f32, 16000.0);
                        let pcm16 = f32_to_pcm16_bytes(&resampled);
                        let _ = app_clone.emit("audio-data", &pcm16);
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let cfg: cpal::StreamConfig = config.into();
                let app_clone = app.clone();
                device.build_input_stream(
                    &cfg,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let float_data: Vec<f32> =
                            data.iter().map(|&s| s as f32 / 32768.0).collect();
                        let mono = to_mono_f32(&float_data, channels);
                        let resampled = resample(&mono, sample_rate as f32, 16000.0);
                        let pcm16 = f32_to_pcm16_bytes(&resampled);
                        let _ = app_clone.emit("audio-data", &pcm16);
                    },
                    err_fn,
                    None,
                )
            }
            fmt => {
                eprintln!("[Audio] Unsupported format: {:?}", fmt);
                CAPTURING.store(false, Ordering::SeqCst);
                return;
            }
        };

        match result {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    eprintln!("[Audio] Failed to start stream: {}", e);
                    CAPTURING.store(false, Ordering::SeqCst);
                    return;
                }
                println!("[Audio] Capture started");
                while CAPTURING.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                println!("[Audio] Capture stopped");
            }
            Err(e) => {
                eprintln!("[Audio] Build stream failed: {}", e);
                CAPTURING.store(false, Ordering::SeqCst);
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_capture() {
    CAPTURING.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn play_audio(pcm_data: Vec<u8>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("No output device")?;
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(24000),
        buffer_size: cpal::BufferSize::Default,
    };
    let samples: Vec<f32> = pcm_data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    let buf = Arc::new(std::sync::Mutex::new(samples));
    let buf2 = buf.clone();

    std::thread::spawn(move || {
        let stream = match device.build_output_stream(
            &config,
            move |out: &mut [f32], _| {
                let mut src = buf2.lock().unwrap();
                for s in out.iter_mut() {
                    *s = if src.is_empty() { 0.0 } else { src.remove(0) };
                }
            },
            |e| eprintln!("[Playback] {}", e),
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Playback] Build failed: {}", e);
                return;
            }
        };
        if let Err(e) = stream.play() {
            eprintln!("[Playback] Start failed: {}", e);
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    });

    Ok(())
}

#[tauri::command]
fn show_subtitle_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitles") {
        w.set_shadow(false).map_err(|e| e.to_string())?;
        w.set_always_on_top(SUBTITLE_ALWAYS_ON_TOP.load(Ordering::Relaxed)).map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
    }
    app.emit("subtitle-visibility-changed", true).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_subtitle_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitles") {
        w.hide().map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window("subtitle-settings") {
        w.hide().map_err(|e| e.to_string())?;
    }
    app.emit("subtitle-visibility-changed", false).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_subtitle_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitles") {
        w.hide().map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window("subtitle-settings") {
        w.hide().map_err(|e| e.to_string())?;
    }
    app.emit("subtitle-visibility-changed", false).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_subtitle_settings(app: tauri::AppHandle, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    let Some(menu) = app.get_webview_window("subtitle-settings") else {
        return Ok(());
    };

    if let (Some(x), Some(y)) = (x, y) {
        let (x, y) = clamp_subtitle_settings_position(&app, &menu, x, y)?;
        menu.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
    } else if let Some(subtitles) = app.get_webview_window("subtitles") {
        subtitles.set_always_on_top(false).map_err(|e| e.to_string())?;
        if let (Ok(pos), Ok(size)) = (subtitles.outer_position(), subtitles.outer_size()) {
            let menu_x = pos.x + size.width as i32 + 8;
            let menu_y = pos.y + 8;
            let (menu_x, menu_y) = clamp_subtitle_settings_position(&app, &menu, menu_x, menu_y)?;
            menu.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: menu_x, y: menu_y }))
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(subtitles) = app.get_webview_window("subtitles") {
        subtitles.set_always_on_top(false).map_err(|e| e.to_string())?;
    }

    menu.show().map_err(|e| e.to_string())?;
    menu.set_focus().map_err(|e| e.to_string())?;
    menu.set_always_on_top(true).map_err(|e| e.to_string())?;
    Ok(())
}

fn clamp_subtitle_settings_position(
    app: &tauri::AppHandle,
    menu: &tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> Result<(i32, i32), String> {
    let size = menu.outer_size().map_err(|e| e.to_string())?;
    let monitor = app
        .get_webview_window("subtitles")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| menu.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok((x, y));
    };
    let pos = monitor.position();
    let monitor_size = monitor.size();
    let padding = 8;
    let min_x = pos.x + padding;
    let min_y = pos.y + padding;
    let max_x = pos.x + monitor_size.width as i32 - size.width as i32 - padding;
    let max_y = pos.y + monitor_size.height as i32 - size.height as i32 - padding;
    Ok((x.clamp(min_x, max_x.max(min_x)), y.clamp(min_y, max_y.max(min_y))))
}

#[tauri::command]
fn hide_subtitle_settings(app: tauri::AppHandle) -> Result<(), String> {
    close_subtitle_settings_menu(&app)?;
    Ok(())
}

#[tauri::command]
fn show_subtitle_history(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitle-history") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_subtitle_history(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitle-history") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_summary_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("summary") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_summary_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("summary") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_quick_record_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick-record") {
        if let Some(subtitles) = app.get_webview_window("subtitles") {
            if let (Ok(position), Ok(size), Ok(record_size)) = (subtitles.outer_position(), subtitles.outer_size(), w.outer_size()) {
                let x = position.x + size.width as i32 + 12;
                let y = position.y - record_size.height as i32 - 12;
                let (x, y) = clamp_subtitle_settings_position(&app, &w, x, y)?;
                w.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
                    .map_err(|e| e.to_string())?;
            }
        }
        w.set_always_on_top(true).map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_quick_record_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick-record") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn close_subtitle_settings_menu(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitle-settings") {
        w.hide().map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window("subtitles") {
        w.set_always_on_top(SUBTITLE_ALWAYS_ON_TOP.load(Ordering::Relaxed)).map_err(|e| e.to_string())?;
    }
    app.emit("subtitle-settings-closed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_subtitle_background_active(active: bool) {
    SUBTITLE_BG_ACTIVE.store(active, Ordering::Relaxed);
}

#[tauri::command]
fn set_subtitle_hit_areas(areas: Vec<SubtitleHitArea>) {
    if let Ok(mut hit_areas) = SUBTITLE_HIT_AREAS.lock() {
        *hit_areas = areas;
    }
}

#[tauri::command]
fn set_lock_button_rect(x: f64, y: f64, w: f64, h: f64) {
    if let Ok(mut rect) = LOCK_BUTTON_RECT.lock() {
        *rect = (x, y, w, h);
    }
}

#[tauri::command]
fn toggle_lock(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitles") {
        w.set_ignore_cursor_events(locked).map_err(|e| e.to_string())?;
        LOCKED.store(locked, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn set_subtitle_always_on_top(app: tauri::AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("subtitles") {
        w.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
        SUBTITLE_ALWAYS_ON_TOP.store(always_on_top, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn show_taskbar_minimize_notification(app: tauri::AppHandle) -> Result<(), String> {
    let app_handle = app.clone();
    Toast::new(Toast::POWERSHELL_APP_ID)
        .title("应用已最小化到任务栏")
        .text1("字幕窗口会继续显示。")
        .duration(ToastDuration::Short)
        .add_button("不再提示", "never-show-taskbar-minimize-tip")
        .on_activated(move |action| {
            if action.as_deref() == Some("never-show-taskbar-minimize-tip") {
                let _ = app_handle.emit("taskbar-minimize-tip-never", ());
            }
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("subtitles") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("subtitle-settings") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("subtitle-history") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("summary") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("quick-record") {
        let _ = w.hide();
    }
    app.exit(0);
}

fn start_lock_tracking(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Lock button: top:8px, right:10px + padding:4px → expanded hit area
        let lock_w: f64 = 40.0;
        let lock_h: f64 = 40.0;
        let lock_top: f64 = 5.0;
        let lock_right: f64 = 7.0;
        let controls_w: f64 = 250.0;
        let controls_h: f64 = 44.0;
        let controls_top: f64 = 0.0;
        let controls_right: f64 = 0.0;

        let mut was_in_window = false;
        let mut was_in_hit_area = false;
        let mut left_button_down = false;

        loop {
            let locked = LOCKED.load(Ordering::Relaxed);
            let bg_active = SUBTITLE_BG_ACTIVE.load(Ordering::Relaxed);
            let current_left_button_down = unsafe { GetAsyncKeyState(VK_LBUTTON) } < 0;
            let left_button_pressed = current_left_button_down && !left_button_down;
            left_button_down = current_left_button_down;
            let mut in_window = false;
            let mut in_hit_area = false;
            let mut in_subtitle_controls = false;
            let mut cursor = None;

            if let Some(w) = app.get_webview_window("subtitles") {
                if let (Ok(pos), Ok(size), Ok(scale_factor)) = (w.inner_position(), w.inner_size(), w.scale_factor()) {
                    let in_lock;
                    let in_controls;
                    let wx = pos.x as f64;
                    let wy = pos.y as f64;
                    let ww = size.width as f64;
                    let wh = size.height as f64;

                    let mut pt = POINT { x: 0, y: 0 };
                    if unsafe { GetCursorPos(&mut pt) } != 0 {
                        let cx = pt.x as f64;
                        let cy = pt.y as f64;
                        cursor = Some((cx, cy));

                        // Entire window region
                        in_window = cx >= wx && cx <= wx + ww
                            && cy >= wy && cy <= wy + wh;

                        if let Ok(areas) = SUBTITLE_HIT_AREAS.lock() {
                            in_hit_area = areas.iter().any(|area| {
                                let hx = wx + area.x * scale_factor;
                                let hy = wy + area.y * scale_factor;
                                let hw = area.w * scale_factor;
                                let hh = area.h * scale_factor;
                                hw > 0.0 && hh > 0.0
                                    && cx >= hx && cx <= hx + hw
                                    && cy >= hy && cy <= hy + hh
                            });
                        }

                        // Lock button region: top-right when unlocked, synced rect when locked
                        let (l_left, l_top, l_w, l_h) = if locked {
                            if let Ok(rect) = LOCK_BUTTON_RECT.lock() {
                                (
                                    wx + rect.0 * scale_factor,
                                    wy + rect.1 * scale_factor,
                                    rect.2 * scale_factor,
                                    rect.3 * scale_factor,
                                )
                            } else {
                                (0.0, 0.0, 0.0, 0.0)
                            }
                        } else {
                            (wx + ww - lock_right - lock_w, wy + lock_top, lock_w, lock_h)
                        };
                        in_lock = cx >= l_left && cx <= l_left + l_w
                            && cy >= l_top && cy <= l_top + l_h;

                        let c_left = wx + ww - controls_right - controls_w;
                        let c_top = wy + controls_top;
                        in_controls = cx >= c_left && cx <= c_left + controls_w
                            && cy >= c_top && cy <= c_top + controls_h;
                        in_subtitle_controls = in_controls;
                    } else {
                        in_lock = false;
                        in_controls = false;
                    }

                    // Emit event when mouse leaves window
                    if was_in_window && !in_window {
                        let _ = app.emit("lock-mouse-left", ());
                    }
                    was_in_window = in_window;

                    let hover_active = in_hit_area || (bg_active && in_window);
                    if hover_active {
                        let _ = app.emit("subtitle-hit-hover", ());
                    } else if was_in_hit_area {
                        let _ = app.emit("subtitle-hit-leave", ());
                    }
                    was_in_hit_area = hover_active;

                    // In locked mode: click-through unless over lock button.
                    // In unlocked mode: empty subtitle window area stays click-through
                    // until the background has appeared, except for the controls region.
                    let ignore = if locked {
                        !in_lock
                    } else {
                        !(in_controls || in_hit_area || (bg_active && in_window))
                    };
                    let _ = w.set_ignore_cursor_events(ignore);
                }
            }

            if let (Some((cx, cy)), Some(menu)) = (cursor, app.get_webview_window("subtitle-settings")) {
                if menu.is_visible().unwrap_or(false) {
                    let mut in_menu = false;
                    if let (Ok(pos), Ok(size)) = (menu.outer_position(), menu.outer_size()) {
                        let mx = pos.x as f64;
                        let my = pos.y as f64;
                        let mw = size.width as f64;
                        let mh = size.height as f64;
                        in_menu = cx >= mx && cx <= mx + mw && cy >= my && cy <= my + mh;
                    }

                    if left_button_pressed && !(in_subtitle_controls || in_menu) {
                        let _ = close_subtitle_settings_menu(&app);
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(80));
        }
    });
}

fn to_mono_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample(input: &[f32], src_rate: f32, target_rate: f32) -> Vec<f32> {
    if (src_rate - target_rate).abs() < 1.0 {
        return input.to_vec();
    }
    let ratio = target_rate / src_rate;
    let new_len = (input.len() as f32 * ratio) as usize;
    if new_len == 0 {
        return Vec::new();
    }
    let mut output = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src_pos = i as f32 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f32;
        let sample = if idx + 1 < input.len() {
            input[idx] * (1.0 - frac) + input[idx + 1] * frac
        } else if idx < input.len() {
            input[idx]
        } else {
            0.0
        };
        output.push(sample);
    }
    output
}

fn f32_to_pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let mut tray = TrayIconBuilder::new().tooltip("会议字幕翻译");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Force decorations off on main window
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
                let _ = w.set_resizable(true);
                let _ = w.set_content_protected(false);
            }
            // Set up subtitle window chrome and default click-through mode.
            if let Some(w) = app.get_webview_window("subtitles") {
                let _ = w.set_decorations(false);
                let _ = w.set_always_on_top(SUBTITLE_ALWAYS_ON_TOP.load(Ordering::Relaxed));
                let _ = w.set_skip_taskbar(true);
                let _ = w.set_resizable(true);
                let _ = w.set_ignore_cursor_events(false);
                let _ = w.set_shadow(false);
                let _ = w.show();
            }
            if let Some(w) = app.get_webview_window("subtitle-settings") {
                let _ = w.set_decorations(false);
                let _ = w.set_always_on_top(true);
                let _ = w.set_skip_taskbar(true);
                let _ = w.set_resizable(false);
                let _ = w.set_shadow(false);
            }
            if let Some(w) = app.get_webview_window("subtitle-history") {
                let _ = w.set_decorations(false);
                let _ = w.set_resizable(true);
                let _ = w.set_shadow(false);
            }
            if let Some(w) = app.get_webview_window("summary") {
                let _ = w.set_decorations(false);
                let _ = w.set_resizable(true);
                let _ = w.set_shadow(false);
            }
            if let Some(w) = app.get_webview_window("quick-record") {
                let _ = w.set_decorations(false);
                let _ = w.set_always_on_top(true);
                let _ = w.set_skip_taskbar(true);
                let _ = w.set_resizable(true);
                let _ = w.set_shadow(false);
            }
            // Start mouse tracking for subtitle window
            start_lock_tracking(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gemini_connect,
            gemini_send,
            gemini_disconnect,
            gemini_generate_text,
            gemini_generate_text_stream,
            gemini_cancel_text_stream,
            load_session_archive,
            save_session_archive,
            load_summary_items,
            save_summary_items,
            get_audio_devices,
            start_capture,
            stop_capture,
            play_audio,
            show_subtitle_window,
            hide_subtitle_window,
            close_subtitle_window,
            show_subtitle_settings,
            hide_subtitle_settings,
            show_subtitle_history,
            hide_subtitle_history,
            show_summary_window,
            hide_summary_window,
            show_quick_record_window,
            hide_quick_record_window,
            set_subtitle_background_active,
            set_subtitle_hit_areas,
            set_lock_button_rect,
            toggle_lock,
            set_subtitle_always_on_top,
            show_taskbar_minimize_notification,
            hide_main_window,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
