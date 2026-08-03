use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
static GEMINI_TX: Mutex<Option<mpsc::UnboundedSender<String>>> = Mutex::new(None);
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

#[tauri::command]
async fn gemini_connect(app: tauri::AppHandle, url: String, proxy_url: Option<String>) -> Result<(), String> {
    gemini_disconnect();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if let Ok(mut slot) = GEMINI_TX.lock() {
        *slot = Some(tx);
    }

    tauri::async_runtime::spawn(async move {
        let result = async {
            app.emit("gemini-log", "正在创建网络连接").map_err(|e| e.to_string())?;
            let stream = connect_proxy_stream(&url, proxy_url.as_deref()).await?;
            app.emit("gemini-log", "网络连接已建立，正在进行 WebSocket 握手").map_err(|e| e.to_string())?;
            let (ws, _) = client_async_tls_with_config(url.as_str(), stream, None, None)
                .await
                .map_err(|e| e.to_string())?;
            let (mut write, mut read) = ws.split();
            app.emit("gemini-open", ()).map_err(|e| e.to_string())?;

            loop {
                tokio::select! {
                    outgoing = rx.recv() => {
                        match outgoing {
                            Some(text) => write.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
                            None => break,
                        }
                    }
                    incoming = read.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => app.emit("gemini-message", text.to_string()).map_err(|e| e.to_string())?,
                            Some(Ok(Message::Binary(data))) => app.emit("gemini-message", String::from_utf8_lossy(&data).to_string()).map_err(|e| e.to_string())?,
                            Some(Ok(Message::Close(frame))) => {
                                let reason = frame
                                    .map(|v| format!("WebSocket 被关闭：{} {}", v.code, v.reason))
                                    .unwrap_or_else(|| "WebSocket 被关闭".to_string());
                                app.emit("gemini-log", reason).map_err(|e| e.to_string())?;
                                break;
                            }
                            None => {
                                app.emit("gemini-log", "WebSocket 数据流结束").map_err(|e| e.to_string())?;
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

        if let Ok(mut slot) = GEMINI_TX.lock() {
            *slot = None;
        }
        if let Err(e) = result {
            let _ = app.emit("gemini-error", e);
        }
        let _ = app.emit("gemini-close", ());
    });

    Ok(())
}

#[tauri::command]
fn gemini_send(message: String) -> Result<(), String> {
    let tx = GEMINI_TX
        .lock()
        .map_err(|_| "Gemini connection lock failed".to_string())?
        .clone()
        .ok_or("Gemini is not connected")?;
    tx.send(message).map_err(|_| "Gemini connection is closed".to_string())
}

#[tauri::command]
fn gemini_disconnect() {
    if let Ok(mut slot) = GEMINI_TX.lock() {
        *slot = None;
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

#[tauri::command]
fn get_audio_devices() -> (Vec<String>, String) {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();
    let mut devices = Vec::new();
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(name) = device.name() {
                devices.push(name);
            }
        }
    }
    (devices, default_name)
}

#[tauri::command]
fn start_capture(app: tauri::AppHandle) -> Result<(), String> {
    if CAPTURING.load(Ordering::SeqCst) {
        return Ok(());
    }

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No output device found")?;

    let config = device
        .default_output_config()
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
    app.exit(0);
}

fn start_lock_tracking(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Lock button: top:8px, right:10px + padding:4px → expanded hit area
        let lock_w: f64 = 40.0;
        let lock_h: f64 = 40.0;
        let lock_top: f64 = 5.0;
        let lock_right: f64 = 7.0;
        let controls_w: f64 = 112.0;
        let controls_h: f64 = 44.0;
        let controls_top: f64 = 0.0;
        let controls_right: f64 = 0.0;

        let mut was_in_window = false;
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
                if let (Ok(pos), Ok(size), Ok(scale_factor)) = (w.outer_position(), w.outer_size(), w.scale_factor()) {
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

                        // Lock button region
                        let l_left = wx + ww - lock_right - lock_w;
                        let l_top = wy + lock_top;
                        in_lock = cx >= l_left && cx <= l_left + lock_w
                            && cy >= l_top && cy <= l_top + lock_h;

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

                    if in_hit_area || (bg_active && in_window) {
                        let _ = app.emit("subtitle-hit-hover", ());
                    }

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
            // Start mouse tracking for subtitle window
            start_lock_tracking(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gemini_connect,
            gemini_send,
            gemini_disconnect,
            get_audio_devices,
            start_capture,
            stop_capture,
            play_audio,
            show_subtitle_window,
            hide_subtitle_window,
            close_subtitle_window,
            show_subtitle_settings,
            hide_subtitle_settings,
            set_subtitle_background_active,
            set_subtitle_hit_areas,
            toggle_lock,
            set_subtitle_always_on_top,
            show_taskbar_minimize_notification,
            hide_main_window,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
